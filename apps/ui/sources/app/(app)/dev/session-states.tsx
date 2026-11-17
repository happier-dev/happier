import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { MessageView } from '@/components/sessions/transcript/MessageView';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { SessionUsageLimitRecoveryBanner } from '@/components/sessions/usageLimitRecovery/SessionUsageLimitRecoveryBanner';
import { buildSessionUsageLimitRecoveryPresentation } from '@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryPresentation';
import { translateUsageLimitRecoveryPresentationKey } from '@/components/sessions/usageLimitRecovery/translateUsageLimitRecoveryPresentationKey';
import { Text } from '@/components/ui/text/Text';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';

/**
 * Dev-only: Session failure and recovery states that live sessions rarely reach on demand — typed
 * transcript failure rows (model not found, Team refusal, Team reconnect, usage limit, Agent sign-in),
 * the quota card, and the Terminal tool card title. Every frame mounts the real owner with fixture data.
 * `?only=transcript|quota` renders one section.
 */
const NOW = Date.now();

function runtimeRow(
  id: string,
  offsetMs: number,
  text: string,
  issue: Record<string, unknown>,
): Message {
  const normalized = normalizeRawMessage(id, id, NOW - offsetMs, {
    role: 'agent',
    content: {
      type: 'acp',
      agentId: 'codex',
      data: { type: 'message', message: text },
    },
    meta: {
      source: 'runtime',
      runtimeIssueV1: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        occurredAt: NOW - offsetMs,
        ...issue,
      },
    },
  });
  return {
    kind: 'agent-text',
    id,
    localId: null,
    createdAt: NOW - offsetMs,
    text,
    meta: normalized?.meta,
  };
}

function userRow(id: string, offsetMs: number, text: string): Message {
  return {
    kind: 'user-text',
    id,
    localId: null,
    createdAt: NOW - offsetMs,
    text,
  };
}

function terminalCall(
  id: string,
  offsetMs: number,
  command: string[],
  output: string,
): Message {
  return {
    id,
    localId: null,
    createdAt: NOW - offsetMs,
    kind: 'tool-call',
    children: [],
    tool: {
      name: 'Bash',
      state: 'completed',
      input: { command },
      result: { stdout: output, exit_code: 0 },
      createdAt: NOW - offsetMs,
      startedAt: NOW - offsetMs,
      completedAt: NOW - offsetMs + 400,
      description: 'execute',
    },
  };
}

const TRANSCRIPT: Message[] = [
  userRow(
    'ask-tests',
    9 * 60_000,
    'Run the checkout tests and tell me what fails.',
  ),
  terminalCall(
    'terminal-pwd',
    8 * 60_000,
    ['/bin/bash', '-lc', 'pwd'],
    '/Users/maya/code/checkout-web\n',
  ),
  terminalCall(
    'terminal-quoted',
    7 * 60_000,
    ['/bin/zsh', '-lc', 'pnpm vitest run src/cart --reporter=dot'],
    '  42 passed (3.1s)\n',
  ),
  runtimeRow(
    'model-not-found',
    6 * 60_000,
    'codex turn failed: Codex app-server turn failed.',
    {
      code: 'provider_model_not_found',
      source: 'agent_session_error',
      agentId: 'codex',
      failureCause: {
        code: 'provider_model_not_found',
        phase: 'turn',
        failureReason: 'unclassified_provider_error',
        providerErrorCode: 'model_not_found',
      },
    },
  ),
  runtimeRow(
    'model-change-refused',
    5.5 * 60_000,
    'Custom ACP Agent turn failed: Native model transition requires restart: native_model_restart_required; service=qa-cp1-peer',
    {
      code: 'session_model_transition_apply_failed',
      source: 'agent_session_error',
      agentId: 'custom-acp',
      sanitizedPreview: 'Native model transition requires restart: native_model_restart_required; service=qa-cp1-peer',
      failureCause: {
        phase: 'turn',
        failureReason: 'unclassified_provider_error',
        providerErrorCode: -32000,
        providerErrorMessage: 'Native model transition requires restart: native_model_restart_required; service=qa-cp1-peer',
      },
    },
  ),
  runtimeRow(
    'team-denied',
    5 * 60_000,
    'Shared Team credential refused the request',
    {
      code: 'team_credential',
      source: 'team_credential',
      teamCredential: {
        v: 1,
        resourceId: 'design-team-openai',
        reasonCode: 'resource_forbidden',
      },
    },
  ),
  runtimeRow(
    'team-reconnect',
    4 * 60_000,
    'Shared Team credential refused the request',
    {
      code: 'team_credential',
      source: 'team_credential',
      teamCredential: {
        v: 1,
        resourceId: 'design-team-openai',
        reasonCode: 'connected_service_credential_reconnect_required',
      },
    },
  ),
  runtimeRow(
    'usage-limit',
    3 * 60_000,
    'codex turn failed: Usage limit reached',
    {
      code: 'usage_limit',
      source: 'usage_limit',
      agentId: 'codex',
      sanitizedPreview:
        'Codex usage limit reached. Try another connected account or try again after your limit resets.',
      usageLimit: {
        v: 1,
        resetAtMs: NOW + 3 * 3_600_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
      },
    },
  ),
  runtimeRow(
    'agent-sign-in',
    2 * 60_000,
    'codex turn failed: The Provider endpoint requires a credential.',
    {
      code: 'provider_endpoint_auth_required',
      source: 'auth_error',
      agentId: 'codex',
    },
  ),
];

const QUOTA_ISSUE = SessionRuntimeIssueV1Schema.parse({
  v: 1,
  scope: 'primary_session',
  status: 'failed',
  code: 'usage_limit',
  source: 'usage_limit',
  occurredAt: NOW - 60_000,
  agentId: 'codex',
  usageLimit: {
    v: 1,
    resetAtMs: NOW + 2 * 3_600_000 + 14 * 60_000,
    retryAfterMs: null,
    quotaScope: 'account',
    recoverability: 'switch_account',
    connectedService: {
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'team',
      groupExhausted: false,
    },
  },
});

function QuotaFrame(props: Readonly<{ mode: 'ask' | 'auto_wait' }>) {
  const presentation = buildSessionUsageLimitRecoveryPresentation({
    featureEnabled: true,
    lastRuntimeIssue: QUOTA_ISSUE,
    recoveryState: null,
    machineReachable: true,
    checkNowSupported: true,
    nowMs: NOW,
    settings: { v: 1, mode: props.mode },
    translate: translateUsageLimitRecoveryPresentationKey,
  });
  if (!presentation)
    return <Text>No quota presentation for this fixture.</Text>;
  const { banner } = presentation;
  return (
    <SessionUsageLimitRecoveryBanner
      runtimeIssue={QUOTA_ISSUE}
      accountLabel="Work (maya@northwind.dev)"
      onUseAnotherAccount={() => {}}
      accountRecoveryIsPrimary={banner.mode === 'switch_account_now'}
      temporaryThrottle={banner.temporaryThrottle}
      testID={banner.testID}
      actionTestID={banner.actionTestID}
      title={banner.title}
      body={banner.body}
      actionLabel={banner.actionLabel}
      actionAccessibilityLabel={banner.actionAccessibilityLabel}
      disabled={banner.actionsDisabled}
      onActionPress={() => {}}
      secondaryActions={banner.secondaryActions.map((action) => ({
        key: action.kind,
        accessibilityLabel: action.accessibilityLabel,
        label: action.label,
        testID: action.testID,
        disabled: banner.actionsDisabled,
        onPress: () => {},
      }))}
    />
  );
}

export default function SessionStatesDevScreen() {
  const params = useLocalSearchParams<{ only?: string }>();
  const only = typeof params.only === 'string' ? params.only : null;
  const source = useDemoMessages(TRANSCRIPT);
  const messagesById = source.useMessagesById();
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {only === null || only === 'transcript' ? (
        <SessionTranscriptSourceProvider source={source}>
          <View style={styles.section}>
            {TRANSCRIPT.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                metadata={null}
                sessionId={source.sessionId}
                getMessageById={(id: string): Message | null =>
                  messagesById[id] ?? null
                }
              />
            ))}
          </View>
        </SessionTranscriptSourceProvider>
      ) : null}
      {only === null || only === 'quota' ? (
        <View style={styles.section}>
          <QuotaFrame mode="ask" />
          <QuotaFrame mode="auto_wait" />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.surface.base },
  content: { paddingVertical: theme.space.s20, alignItems: 'center' },
  section: {
    width: '100%',
    maxWidth: 820,
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    marginBottom: theme.space.s32,
  },
}));
