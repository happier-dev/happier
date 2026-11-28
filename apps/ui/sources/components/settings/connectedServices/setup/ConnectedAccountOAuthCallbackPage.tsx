import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import type { NavigationProp } from '@react-navigation/native';

import { useAuth } from '@/auth/context/AuthContext';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
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
import { resolveConnectedAccountOAuthDenialReason } from '../connectedServiceSettingsErrors';

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
 * its own origin, or the same path opened in the app by its universal link), so only the query is read
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

export type ConnectedAccountOAuthCallbackView = Readonly<{ kind: 'working' }> | ConnectedAccountOAuthCallbackOutcome;

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

export function readConnectedAccountOAuthCallbackCopy(): ConnectedAccountOAuthCallbackCopy {
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
  copy = readConnectedAccountOAuthCallbackCopy(),
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
  const navigation = useNavigation<NavigationProp<{ Callback: Partial<Record<typeof RESPONSE_PARAMS[number], string>> }>>();
  const params = useLocalSearchParams();
  const auth = useAuth();
  const settingsScope = useAccountSettingsScope();
  const scope = auth.isAuthenticated && settingsScope ? settingsScope : null;
  const execution = useMountedActionExecution(scope);
  const [view, setView] = React.useState<ConnectedAccountOAuthCallbackView>({ kind: 'working' });
  const writeClipboard = useClipboardWrite(scope, { enabled: view.kind === 'paste' || view.kind === 'unfinished' });
  const [copied, setCopied] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
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
      .catch(() => setView({ kind: 'paste', answer: callbackUrl }));
  }, [callbackUrl, execution, router, scope, protocol]);

  const openConnections = React.useCallback(
    () => router.replace(openConnectionsPath as never),
    [router, openConnectionsPath],
  );
  const copyAnswer = React.useCallback(async () => {
    if (view.kind !== 'paste' && view.kind !== 'unfinished') return;
    setCopied(await writeClipboard(view.answer));
  }, [view, writeClipboard]);
  const retry = React.useCallback(async () => {
    if (retrying || view.kind !== 'denied') return;
    if (!view.retry) return openConnections();
    setRetrying(true);
    try {
      const attempt = await view.retry();
      if (!execution.isCurrent()) return;
      if (attempt.status === 'awaitingOAuth' && attempt.authorizationUrl) {
        const opened = await execution.execute('links.openExternal', { url: attempt.authorizationUrl }, {});
        if (opened.ok && typeof opened.result === 'object' && opened.result !== null
            && 'status' in opened.result && opened.result.status === 'opened') return;
      }
      openConnections();
    } catch {
      if (execution.isCurrent()) openConnections();
    } finally {
      setRetrying(false);
    }
  }, [execution, openConnections, retrying, view]);

  return (
    <ConnectedAccountOAuthCallbackStateView
      view={view}
      copy={copy}
      testIdPrefix={testIdPrefix}
      invalidClientCopy={invalidClientCopy}
      copied={copied}
      onCopy={copyAnswer}
      onOpenConnections={openConnections}
      onRetry={retry}
      retrying={retrying}
      canOpenConnectionsWhenInvalid={auth.isAuthenticated}
    />
  );
}

/**
 * What the callback page shows for each outcome. Where the answer goes back by hand, the answer itself is
 * on the page (the value Copy writes), so the person sees what they carry, as on a provider's own
 * sign-in code page.
 */
export function ConnectedAccountOAuthCallbackStateView(props: Readonly<{
  view: ConnectedAccountOAuthCallbackView;
  copy: ConnectedAccountOAuthCallbackCopy;
  testIdPrefix: string;
  invalidClientCopy?: Readonly<{ title: string; body: string }>;
  copied: boolean;
  onCopy: () => unknown;
  onOpenConnections: () => unknown;
  onRetry?: () => unknown;
  retrying?: boolean;
  canOpenConnectionsWhenInvalid: boolean;
}>) {
  const { view, copy, testIdPrefix, invalidClientCopy } = props;
  const copyLabel = props.copied ? copy.copied : copy.copyCode;
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
          // One step is left, not nothing: the glyph names that step (copy the code back), not an empty tray.
          iconName="clipboard"
          title={copy.pasteTitle}
          reason={copy.pasteBody}
          body={<CallbackAnswer testID={testIdPrefix + ':answer'} answer={view.answer} />}
          action={{
            testID: testIdPrefix + ':copy',
            label: copyLabel,
            onPress: props.onCopy,
          }}
        />
      );
      break;
    case 'denied': {
      const cancelled = view.denial.error === 'access_denied';
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + ':denied'}
          kind={cancelled ? 'warning' : 'error'}
          title={cancelled ? resolveConnectedAccountOAuthDenialReason(view.denial)
            : view.providerName ? t('capabilities.connectedAccountCallback.providerDeniedTitle', { providerName: view.providerName })
            : t('capabilities.connectedAccountCallback.deniedTitle')}
          reason={cancelled ? undefined : resolveConnectedAccountOAuthDenialReason(view.denial)}
          action={{
            testID: testIdPrefix + ':retry',
            label: t('capabilities.connectedAccountCallback.tryAgain'),
            busy: props.retrying,
            disabled: props.retrying,
            onPress: props.onRetry ?? props.onOpenConnections,
          }}
        />
      );
      break;
    }
    case 'invalid':
      content = (
        <SurfaceStateCard
          testID={testIdPrefix + ':invalid'}
          kind="warning"
          title={copy.invalidTitle}
          reason={copy.invalidBody}
          action={
            props.canOpenConnectionsWhenInvalid
              ? {
                  label: copy.openConnections,
                  onPress: props.onOpenConnections,
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
          body={<CallbackAnswer testID={testIdPrefix + ':answer'} answer={view.answer} />}
          action={{
            label: copy.openConnections,
            onPress: props.onOpenConnections,
          }}
          secondaryAction={{
            testID: testIdPrefix + ':copy',
            label: copyLabel,
            onPress: props.onCopy,
          }}
        />
      );
      break;
    }
  }
  return <View style={styles.page}>{content}</View>;
}

/** The answer in the code face, wrapping at any width; it is selectable, and Copy writes exactly this. */
function CallbackAnswer(props: Readonly<{ answer: string; testID: string }>) {
  return (
    <View testID={props.testID}>
      <CodeBlockView code={props.answer} showHeaderRow={false} wrap />
    </View>
  );
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
