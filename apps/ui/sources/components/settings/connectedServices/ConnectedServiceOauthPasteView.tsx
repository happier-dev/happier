import * as React from 'react';
import { View } from 'react-native';
import tweetnacl from 'tweetnacl';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/StyledText';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/context/AuthContext';
import { sync } from '@/sync/sync';
import { exchangeConnectedServiceOauthViaProxy, registerConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { sealConnectedServiceCredential } from '@/sync/domains/connectedServices/sealConnectedServiceCredential';
import { generateOauthState, generatePkceCodes, parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceIdSchema,
  decodeBase64,
  encodeBase64,
  openBoxBundle,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  buildOpenAiCodexAuthorizationUrl,
  OPENAI_CODEX_OAUTH,
} from '@/sync/domains/connectedServices/oauth/openAiCodexOauth';
import {
  buildAnthropicAuthorizationUrl,
  ANTHROPIC_OAUTH,
} from '@/sync/domains/connectedServices/oauth/anthropicOauth';
import {
  buildGeminiAuthorizationUrl,
  GEMINI_OAUTH,
} from '@/sync/domains/connectedServices/oauth/geminiOauth';

type ProxyExchangePayload = Readonly<{
  serviceId: ConnectedServiceId;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  providerEmail: string | null;
  providerAccountId: string | null;
  expiresAt: number | null;
  raw: unknown;
}>;

function asStringParam(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tryOpenInNewTab(url: string): void {
  try {
    const openFn = (globalThis as unknown as { open?: unknown }).open;
    if (typeof openFn === 'function') {
      (openFn as (url: string, target?: string, features?: string) => unknown)(url, '_blank', 'noopener,noreferrer');
      return;
    }
  } catch {
    // ignore
  }
}

function parseProxyPayload(params: Readonly<{ bundleB64Url: string; recipientSecretKey: Uint8Array }>): ProxyExchangePayload {
  const bytes = decodeBase64(params.bundleB64Url, 'base64url');
  const opened = openBoxBundle({ bundle: bytes, recipientSecretKeyOrSeed: params.recipientSecretKey });
  if (!opened) throw new Error('Failed to decrypt OAuth bundle');
  const json: unknown = JSON.parse(new TextDecoder().decode(opened));
  if (!isRecord(json)) throw new Error('OAuth bundle payload is not an object');
  const serviceId = ConnectedServiceIdSchema.parse(json.serviceId);
  return {
    serviceId,
    accessToken: String(json.accessToken ?? ''),
    refreshToken: String(json.refreshToken ?? ''),
    idToken: typeof json.idToken === 'string' ? json.idToken : null,
    scope: typeof json.scope === 'string' ? json.scope : null,
    tokenType: typeof json.tokenType === 'string' ? json.tokenType : null,
    providerEmail: typeof json.providerEmail === 'string' ? json.providerEmail : null,
    providerAccountId: typeof json.providerAccountId === 'string' ? json.providerAccountId : null,
    expiresAt: typeof json.expiresAt === 'number' ? json.expiresAt : null,
    raw: json.raw ?? null,
  };
}

function buildOauthRecordFromProxyPayload(params: Readonly<{
  now: number;
  serviceId: ConnectedServiceId;
  profileId: string;
  payload: ProxyExchangePayload;
}>): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> {
  const record = buildConnectedServiceCredentialRecord({
    now: params.now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: params.payload.expiresAt,
    oauth: {
      accessToken: params.payload.accessToken,
      refreshToken: params.payload.refreshToken,
      idToken: params.payload.idToken,
      scope: params.payload.scope,
      tokenType: params.payload.tokenType,
      providerAccountId: params.payload.providerAccountId,
      providerEmail: params.payload.providerEmail,
    },
  });
  if (record.kind !== 'oauth') {
    throw new Error(`Unexpected credential record kind: ${record.kind}`);
  }
  return record;
}

export const ConnectedServiceOauthPasteView = React.memo(function ConnectedServiceOauthPasteView(props: Readonly<{
  serviceId: string;
  profileId: string;
  onDone: () => void;
}>) {
  const auth = useAuth();
  const parsedServiceId = ConnectedServiceIdSchema.safeParse(asStringParam(props.serviceId).trim());
  const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
  const profileId = asStringParam(props.profileId).trim();

  const [state, setState] = React.useState<string>('');
  const [pkce, setPkce] = React.useState<{ verifier: string; challenge: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const keyPairRef = React.useRef<tweetnacl.BoxKeyPair | null>(null);
  if (!keyPairRef.current) {
    keyPairRef.current = tweetnacl.box.keyPair();
  }

  React.useEffect(() => {
    let cancelled = false;
    fireAndForget((async () => {
      const nextState = generateOauthState();
      const nextPkce = await generatePkceCodes();
      if (cancelled) return;
      setState(nextState);
      setPkce(nextPkce);
    })(), { tag: 'ConnectedServiceOauthPasteView.initPkce' });
    return () => {
      cancelled = true;
    };
  }, []);

  const redirectUri = React.useMemo(() => {
    if (!serviceId) return '';
    if (serviceId === 'openai-codex') return OPENAI_CODEX_OAUTH.defaultRedirectUri;
    if (serviceId === 'anthropic') return ANTHROPIC_OAUTH.defaultRedirectUri;
    if (serviceId === 'gemini') return GEMINI_OAUTH.defaultRedirectUri;
    return '';
  }, [serviceId]);

  const authorizationUrl = React.useMemo(() => {
    if (!serviceId || !pkce || !state || !redirectUri) return '';
    if (serviceId === 'openai-codex') {
      return buildOpenAiCodexAuthorizationUrl({ redirectUri, state, challenge: pkce.challenge });
    }
    if (serviceId === 'anthropic') {
      return buildAnthropicAuthorizationUrl({ redirectUri, state, challenge: pkce.challenge });
    }
    if (serviceId === 'gemini') {
      return buildGeminiAuthorizationUrl({ redirectUri, state, challenge: pkce.challenge });
    }
    return '';
  }, [pkce, redirectUri, serviceId, state]);

  const ensureCredentials = () => {
    if (!auth.credentials) throw new Error('Not authenticated');
    return auth.credentials;
  };

  const handlePaste = React.useCallback(async () => {
    if (!serviceId || !pkce || !state || !profileId) return;
    setBusy(true);
    try {
      const pasted = await Modal.prompt(
        'Paste redirect URL',
        'After completing OAuth, copy the final redirected URL from your browser address bar and paste it here.',
        { placeholder: redirectUri, confirmText: 'Continue', cancelText: 'Cancel' },
      );
      const pastedUrl = typeof pasted === 'string' ? pasted.trim() : '';
      if (!pastedUrl) return;

      const parsed = parseOauthCallbackUrl({ url: pastedUrl, redirectUri });
      if (parsed.error) throw new Error(`OAuth error: ${parsed.error}`);
      const code = parsed.code ?? '';
      const returnedState = parsed.state ?? '';
      if (!code) throw new Error('Missing code');
      if (!returnedState || returnedState !== state) throw new Error('State mismatch');

      const credentials = ensureCredentials();
      const publicKeyB64Url = encodeBase64(keyPairRef.current!.publicKey, 'base64url');

      const exchanged = await exchangeConnectedServiceOauthViaProxy(credentials, {
        serviceId,
        publicKey: publicKeyB64Url,
        code,
        verifier: pkce.verifier,
        redirectUri,
        state: serviceId === 'anthropic' ? returnedState : null,
      });

      const payload = parseProxyPayload({
        bundleB64Url: exchanged.bundle,
        recipientSecretKey: keyPairRef.current!.secretKey,
      });

      const now = Date.now();
      const record = buildOauthRecordFromProxyPayload({
        now,
        serviceId,
        profileId,
        payload,
      });

      const ciphertext = sealConnectedServiceCredential({ credentials, record });
      await registerConnectedServiceCredentialSealed(credentials, {
        serviceId,
        profileId,
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: record.kind,
          providerEmail: record.oauth.providerEmail,
          providerAccountId: record.oauth.providerAccountId,
          expiresAt: record.expiresAt,
        },
      });

      await sync.refreshProfile();
      await Modal.alert('Connected', `${serviceId} (${profileId}) is connected.`);
      props.onDone();
    } catch (e: unknown) {
      await Modal.alert('Error', e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }, [auth.credentials, pkce, profileId, props, redirectUri, serviceId, state]);

  if (!serviceId || !profileId) {
    return (
      <ItemList>
        <ItemGroup title="Connected Services">
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ opacity: 0.7 }}>Invalid connected service configuration.</Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ItemGroup title="Connect (web)">
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ opacity: 0.7 }}>
            This flow uses a copy/paste redirect step (like OpenClaw) and a Happier server proxy to exchange tokens safely.
          </Text>
        </View>

        <Item
          title="Open authorization URL"
          subtitle={authorizationUrl ? 'Opens in a new tab' : 'Preparing…'}
          onPress={() => {
            if (!authorizationUrl) return;
            tryOpenInNewTab(authorizationUrl);
          }}
        />

        <Item
          title={busy ? 'Working…' : 'Paste redirect URL'}
          subtitle={redirectUri}
          onPress={busy ? undefined : handlePaste}
          showChevron={false}
        />
      </ItemGroup>
    </ItemList>
  );
});
