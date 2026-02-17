import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { OAuthView, OAuthViewUnsupported, type OAuthViewConfig } from '@/components/ui/navigation/OAuthView';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { registerConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { sealConnectedServiceCredential } from '@/sync/domains/connectedServices/sealConnectedServiceCredential';
import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildConnectedServiceCredentialRecord, ConnectedServiceCredentialRecordV1Schema, ConnectedServiceIdSchema, type ConnectedServiceCredentialRecordV1, type ConnectedServiceId } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { buildOpenAiCodexAuthorizationUrl, exchangeOpenAiCodexTokens, OPENAI_CODEX_OAUTH } from '@/sync/domains/connectedServices/oauth/openAiCodexOauth';
import { buildAnthropicAuthorizationUrl, exchangeAnthropicTokens, ANTHROPIC_OAUTH } from '@/sync/domains/connectedServices/oauth/anthropicOauth';
import { buildGeminiAuthorizationUrl, exchangeGeminiTokens, GEMINI_OAUTH } from '@/sync/domains/connectedServices/oauth/geminiOauth';
import { ConnectedServiceOauthPasteView } from './ConnectedServiceOauthPasteView';

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export const ConnectedServiceOauthView = React.memo(function ConnectedServiceOauthView() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');

  const rawServiceId = asStringParam(params.serviceId).trim();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam(params.profileId).trim();

  const entry = serviceId ? getConnectedServiceRegistryEntry(serviceId) : null;

  if (!serviceId || !entry || !profileId) {
    return (
      <View style={{ flex: 1 }}>
        <OAuthViewUnsupported name={rawServiceId || 'Connected service'} command={entry?.connectCommand} />
      </View>
    );
  }

  if (!connectedServicesEnabled) {
    return (
      <View style={{ flex: 1 }}>
        <OAuthViewUnsupported name={entry.displayName} command={entry.connectCommand} />
      </View>
    );
  }

  if (Platform.OS === 'web') {
    return (
      <ConnectedServiceOauthPasteView
        serviceId={rawServiceId}
        profileId={profileId}
        onDone={() => router.back()}
      />
    );
  }

  const ensureCredentials = () => {
    if (!auth.credentials) throw new Error('Not authenticated');
    return auth.credentials;
  };

  const registerRecord = async (record: ConnectedServiceCredentialRecordV1) => {
    const credentials = ensureCredentials();
    const ciphertext = sealConnectedServiceCredential({ credentials, record });
    await registerConnectedServiceCredentialSealed(credentials, {
      serviceId,
      profileId,
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: {
        kind: record.kind,
        providerEmail: record.kind === 'oauth' ? record.oauth.providerEmail : record.token.providerEmail,
        providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : record.token.providerAccountId,
        expiresAt: record.expiresAt,
      },
    });
    await sync.refreshProfile();
  };

  const registerMaybeRecord = async (record: unknown) => {
    const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(record);
    if (!parsed.success) throw new Error('OAuth flow returned an invalid credential record');
    await registerRecord(parsed.data);
  };

  const buildOAuthConfig = () => {
    if (serviceId === 'openai-codex') {
      const redirectUri = OPENAI_CODEX_OAUTH.defaultRedirectUri;
      const config: OAuthViewConfig = {
        redirectUri,
        authUrl: (pkce, state: string, uri: string) =>
          buildOpenAiCodexAuthorizationUrl({ redirectUri: uri, state, challenge: pkce.challenge }),
        tokenExchange: async (code: string, verifier: string, _state: string) => {
          const now = Date.now();
          const tokens = await exchangeOpenAiCodexTokens({ code, verifier, redirectUri, now });
          return buildConnectedServiceCredentialRecord({
            now,
            serviceId,
            profileId,
            kind: 'oauth',
            expiresAt: tokens.expiresAt,
            oauth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              idToken: tokens.idToken,
              scope: null,
              tokenType: null,
              providerAccountId: tokens.providerAccountId,
              providerEmail: null,
            },
          });
        },
        onSuccess: (record: unknown) => {
          void (async () => {
            try {
              await registerMaybeRecord(record);
              await Modal.alert('Connected', `${entry.displayName} (${profileId}) is connected.`);
              router.back();
            } catch (e: unknown) {
              await Modal.alert('Error', e instanceof Error ? e.message : 'Failed to connect');
            }
          })();
        },
      };

      return {
        name: entry.displayName,
        command: entry.connectCommand,
        backgroundColor: '#0B0B0C',
        foregroundColor: '#FFFFFF',
        config,
      };
    }

    if (serviceId === 'anthropic') {
      const redirectUri = ANTHROPIC_OAUTH.defaultRedirectUri;
      const config: OAuthViewConfig = {
        redirectUri,
        authUrl: (pkce, state: string, uri: string) =>
          buildAnthropicAuthorizationUrl({ redirectUri: uri, state, challenge: pkce.challenge }),
        tokenExchange: async (code: string, verifier: string, state: string) => {
          const now = Date.now();
          const tokens = await exchangeAnthropicTokens({ code, verifier, state, redirectUri, now });
          return buildConnectedServiceCredentialRecord({
            now,
            serviceId,
            profileId,
            kind: 'oauth',
            expiresAt: tokens.expiresAt,
            oauth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              idToken: null,
              scope: tokens.scope,
              tokenType: tokens.tokenType,
              providerAccountId: tokens.providerAccountId,
              providerEmail: tokens.providerEmail,
            },
          });
        },
        onSuccess: (record: unknown) => {
          void (async () => {
            try {
              await registerMaybeRecord(record);
              await Modal.alert('Connected', `${entry.displayName} (${profileId}) is connected.`);
              router.back();
            } catch (e: unknown) {
              await Modal.alert('Error', e instanceof Error ? e.message : 'Failed to connect');
            }
          })();
        },
      };

      return {
        name: entry.displayName,
        command: entry.connectCommand,
        backgroundColor: '#1F1E1C',
        foregroundColor: '#FFFFFF',
        config,
      };
    }

    if (serviceId === 'gemini') {
      const redirectUri = GEMINI_OAUTH.defaultRedirectUri;
      const config: OAuthViewConfig = {
        redirectUri,
        authUrl: (pkce, state: string, uri: string) =>
          buildGeminiAuthorizationUrl({ redirectUri: uri, state, challenge: pkce.challenge }),
        tokenExchange: async (code: string, verifier: string, _state: string) => {
          const now = Date.now();
          const tokens = await exchangeGeminiTokens({ code, verifier, redirectUri, now });
          return buildConnectedServiceCredentialRecord({
            now,
            serviceId,
            profileId,
            kind: 'oauth',
            expiresAt: tokens.expiresAt,
            oauth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              idToken: tokens.idToken,
              scope: tokens.scope,
              tokenType: tokens.tokenType,
              providerAccountId: null,
              providerEmail: null,
            },
          });
        },
        onSuccess: (record: unknown) => {
          void (async () => {
            try {
              await registerMaybeRecord(record);
              await Modal.alert('Connected', `${entry.displayName} (${profileId}) is connected.`);
              router.back();
            } catch (e: unknown) {
              await Modal.alert('Error', e instanceof Error ? e.message : 'Failed to connect');
            }
          })();
        },
      };

      return {
        name: entry.displayName,
        command: entry.connectCommand,
        backgroundColor: '#0B1A2B',
        foregroundColor: '#FFFFFF',
        config,
      };
    }

    return null;
  };

  const cfg = buildOAuthConfig();
  if (!cfg) {
    return <OAuthViewUnsupported name={entry.displayName} command={entry.connectCommand} />;
  }

  return (
    <OAuthView
      name={cfg.name}
      command={cfg.command}
      backgroundColor={cfg.backgroundColor}
      foregroundColor={cfg.foregroundColor}
      config={cfg.config}
    />
  );
});
