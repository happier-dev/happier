import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import {
  CONNECTED_ACCOUNT_OAUTH_CALLBACK_PROTOCOL,
  createConnectedAccountOAuthCallbackController,
  type ConnectedAccountOAuthCallbackProtocol,
  type ConnectedAccountOAuthCallbackInput,
  type ConnectedAccountOAuthCallbackOutcome,
} from '@/sync/ops/connectedAccounts/connectedAccountOAuthCallback';
import {
  readCapturedConnectedAccountOAuthCallbackUrl,
  releaseCapturedConnectedAccountOAuthCallbackUrl,
} from '@/sync/ops/connectedAccounts/connectedAccountOAuthCallbackUrl';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

const RESPONSE_PARAMS = [
  'code',
  'state',
  'iss',
  'error',
  'error_description',
  'error_uri',
] as const;

/**
 * The provider's answer, as the canonical callback address. The route *is* that address (the web app at
 * app.happier.dev, or the same path opened in the app by its universal link), so only the query is read
 * here, preferring the web entry's pre-router capture. Parsing and validation stay
 * with the callback controller and the daemon.
 */
function readCallbackUrl(
  params: Readonly<Record<string, string | string[] | undefined>>,
  canonicalCallbackUrl: string,
): string {
  if (Platform.OS === 'web') {
    const captured = readCapturedConnectedAccountOAuthCallbackUrl(canonicalCallbackUrl);
    if (captured) return captured;
  }
  // A warm route commits before Expo mirrors it into browser history. Its params
  // already belong to this callback; location.search may still belong to the previous page.
  const query = new URLSearchParams();
  for (const key of RESPONSE_PARAMS) {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') query.set(key, first);
  }
  const encoded = query.toString();
  if (encoded) return `${canonicalCallbackUrl}?${encoded}`;
  const search =
    Platform.OS === 'web'
      ? (globalThis as { location?: { search?: string } }).location?.search
      : undefined;
  return search
    ? `${canonicalCallbackUrl}${search.startsWith('?') ? search : `?${search}`}`
    : canonicalCallbackUrl;
}

function readBrowser(): ConnectedAccountOAuthCallbackInput['browser'] {
  if (Platform.OS !== 'web') return undefined;
  const browser = globalThis as unknown as {
    history?: {
      state: unknown;
      replaceState(data: unknown, unused: string, url: string): void;
    };
    close?: () => void;
    opener?: { location?: { origin?: string }; postMessage(message: unknown, origin: string): void } | null;
    self?: unknown;
  };
  const opener =
    browser.opener && browser.opener !== browser.self
      ? browser.opener
      : undefined;
  let openerOrigin: string | undefined;
  try {
    openerOrigin = opener?.location?.origin;
  } catch {
    // Cross-origin WindowProxy access is denied; preserve paste recovery.
  }
  return {
    replaceUrl: (path) => {
      browser.history?.replaceState(browser.history.state, '', path);
    },
    close: () => browser.close?.(),
    ...(opener
      ? {
          opener: {
            origin: openerOrigin,
            postMessage: (message, origin) =>
              opener.postMessage(message, origin),
          },
        }
      : {}),
  };
}

type CallbackView = Readonly<{ kind: 'working' }> | ConnectedAccountOAuthCallbackOutcome;

export type ConnectedAccountOAuthCallbackCopy = Readonly<{
  finishing: string;
  closeTitle: string;
  closeBody: string;
  connectedTitle: string;
  connectedBody: string;
  pasteTitle: string;
  pasteBody: string;
  copyCode: string;
  copied: string;
  invalidTitle: string;
  invalidBody: string;
  unfinishedTitle: string;
  unfinishedBody: string;
  openConnections: string;
}>;

function readDefaultCopy(): ConnectedAccountOAuthCallbackCopy {
  return {
    finishing: t('capabilities.connectedAccountCallback.finishing'),
    closeTitle: t('capabilities.connectedAccountCallback.closeTitle'),
    closeBody: t('capabilities.connectedAccountCallback.closeBody'),
    connectedTitle: t('capabilities.connectedAccountCallback.connectedTitle'),
    connectedBody: t('capabilities.connectedAccountCallback.connectedBody'),
    pasteTitle: t('capabilities.connectedAccountCallback.pasteTitle'),
    pasteBody: t('capabilities.connectedAccountCallback.pasteBody'),
    copyCode: t('capabilities.connectedAccountCallback.copyCode'),
    copied: t('capabilities.connectedAccountCallback.copied'),
    invalidTitle: t('capabilities.connectedAccountCallback.invalidTitle'),
    invalidBody: t('capabilities.connectedAccountCallback.invalidBody'),
    unfinishedTitle: t('capabilities.connectedAccountCallback.unfinishedTitle'),
    unfinishedBody: t('capabilities.connectedAccountCallback.unfinishedBody'),
    openConnections: t('capabilities.connectedAccountCallback.openConnections'),
  };
}

/** One relay/recovery page for both public callback protocols. */
export function ConnectedAccountOAuthCallbackPage({
  protocol = CONNECTED_ACCOUNT_OAUTH_CALLBACK_PROTOCOL,
  copy = readDefaultCopy(),
  testIdPrefix = 'connected-account-oauth-callback',
  openConnectionsPath = '/settings/connected-services',
  invalidClientCopy,
}: Readonly<{
  protocol?: ConnectedAccountOAuthCallbackProtocol;
  copy?: ConnectedAccountOAuthCallbackCopy;
  testIdPrefix?: string;
  openConnectionsPath?: string;
  invalidClientCopy?: Readonly<{ title: string; body: string }>;
}> = {}) {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const settingsScope = useAccountSettingsScope();
  const scope = auth.isAuthenticated && settingsScope ? settingsScope : null;
  const execution = useMountedActionExecution(scope);
  const [view, setView] = React.useState<CallbackView>({ kind: 'working' });
  const writeClipboard = useClipboardWrite(scope, { enabled: view.kind === 'paste' || view.kind === 'unfinished' });
  const [copied, setCopied] = React.useState(false);
  const started = React.useRef(false);
  const controller = React.useRef<ReturnType<typeof createConnectedAccountOAuthCallbackController> | null>(null);
  // Read once, before the controller strips the address.
  const callbackUrl = React.useMemo(
    () =>
      readCallbackUrl(params as Record<string, string | string[] | undefined>, protocol.callbackUrl),
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // Strip before passive credential-binding effects can start asynchronous work.
  React.useLayoutEffect(() => {
    controller.current ??= createConnectedAccountOAuthCallbackController({ callbackUrl,
      browser: readBrowser(),
    }, protocol);
    releaseCapturedConnectedAccountOAuthCallbackUrl(protocol.callbackUrl);
    // Clear this mounted route before its later history publication can restore
    // the answer. The global Expo router may not have registered its root yet.
    if (RESPONSE_PARAMS.some(key => params[key] !== undefined)) {
      navigation.setParams(Object.fromEntries(RESPONSE_PARAMS.map(key => [key, undefined])));
    }
  }, [callbackUrl, navigation, params, protocol]);

  React.useEffect(() => {
    const captured = controller.current;
    if (started.current || !captured) return;
    // Signed in: wait for the Account binding so the completion runs under its custody.
    if (scope && !execution.ready) return;
    started.current = true;
    const account: ConnectedAccountOAuthCallbackInput['account'] = scope
      ? {
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
          assertCurrent: () => {
            if (!execution.isCurrent())
              throw Object.assign(new Error('Account changed'), {
                code: 'action_account_scope_changed',
              });
          },
          executeAction: execution.execute,
        }
      : undefined;
    void captured.complete(account)
      .then((outcome) => {
        setView(outcome);
        if (outcome.kind === 'connected')
          router.replace(outcome.returnTo as never);
      })
      // Anything that stops the completion here leaves the answer with the person, to paste.
      .catch(() => setView({ kind: 'paste', callbackUrl }));
  }, [callbackUrl, execution, router, scope, protocol]);

  const openConnections = React.useCallback(
    () => router.replace(openConnectionsPath as never),
    [router, openConnectionsPath],
  );
  const copyCallback = React.useCallback(async () => {
    if (view.kind !== 'paste' && view.kind !== 'unfinished') return;
    setCopied(await writeClipboard(view.callbackUrl));
  }, [view, writeClipboard]);

  let content: React.ReactNode;
  switch (view.kind) {
    case 'working':
      content = (
        <View style={styles.working} testID={testIdPrefix + ':working'}>
          <ActivitySpinner size="small" />
          <Text variant="body" style={styles.workingText}>
            {copy.finishing}
          </Text>
        </View>
      );
      break;
    case 'opener':
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + ':opener'}
          kind="success"
          title={copy.closeTitle}
          reason={copy.closeBody}
        />
      );
      break;
    case 'connected':
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + ':connected'}
          kind="success"
          title={copy.connectedTitle}
          reason={copy.connectedBody}
        />
      );
      break;
    case 'paste':
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + ':paste'}
          kind="empty"
          title={copy.pasteTitle}
          reason={copy.pasteBody}
          action={{
            testID: testIdPrefix + ':copy',
            label: copied
              ? copy.copied
              : copy.copyCode,
            onPress: copyCallback,
          }}
        />
      );
      break;
    case 'invalid':
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + ':invalid'}
          kind="warning"
          title={copy.invalidTitle}
          reason={copy.invalidBody}
          action={
            auth.isAuthenticated
              ? {
                  label: copy.openConnections,
                  onPress: openConnections,
                }
              : undefined
          }
        />
      );
      break;
    case 'unfinished': {
      const invalidClient = Boolean(invalidClientCopy) && view.response.status === 'rejected' && view.response.code === 'invalid_client';
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + (invalidClient ? ':invalid-client' : ':unfinished')}
          kind="warning"
          title={invalidClient ? invalidClientCopy!.title : copy.unfinishedTitle}
          reason={invalidClient ? invalidClientCopy!.body : copy.unfinishedBody}
          action={{
            label: copy.openConnections,
            onPress: openConnections,
          }}
          secondaryAction={{
            testID: testIdPrefix + ':copy',
            label: copied ? copy.copied : copy.copyCode,
            onPress: copyCallback,
          }}
        />
      );
      break;
    }
  }
  return <View style={styles.page}>{content}</View>;
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s16,
  },
  working: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  workingText: { color: theme.colors.text.secondary },
}));
