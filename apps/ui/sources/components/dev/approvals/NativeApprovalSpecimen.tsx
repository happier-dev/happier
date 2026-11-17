import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  NativePermissionChoiceAvailabilityV1,
  NativePermissionChoicesV1,
} from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { PermissionAnswerOutcomeStatus } from '@/components/tools/shell/presentation/ToolOutcomeStatus';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';

export type NativeApprovalSpecimenState =
  | 'two'
  | 'four'
  | 'six'
  | 'long'
  | 'shared'
  | 'child'
  | 'answered';

const SESSION_ID = 'dev-native-approvals';
const once = (id: string, label: string) => ({
  id,
  label,
  decision: 'approved' as const,
  scope: 'once' as const,
  response: { approved: true },
});
const session = (id: string, label: string, rulePreview?: string) => ({
  id,
  label,
  decision: 'approved_for_session' as const,
  scope: 'session' as const,
  ...(rulePreview ? { rulePreview } : {}),
  response: { approved: true },
});
const always = (id: string, label: string, rulePreview?: string) => ({
  id,
  label,
  decision: 'approved' as const,
  scope: 'localPersistent' as const,
  ...(rulePreview ? { rulePreview } : {}),
  response: { approved: true },
});
const reject = (id: string, label: string, rulePreview?: string) => ({
  id,
  label,
  decision: 'denied' as const,
  scope: 'once' as const,
  ...(rulePreview ? { rulePreview } : {}),
  response: { approved: false },
});

const EDIT = {
  tool: 'Edit',
  arguments: {
    file_path: 'src/billing/webhooks.ts',
    old_string: 'await db.payments.insert(event)',
    new_string:
      'await db.payments.upsert(event, { onConflict: "stripe_event_id" })',
  },
};
const OFFERS: Readonly<
  Record<
    Exclude<NativeApprovalSpecimenState, 'answered'>,
    Readonly<{
      request: typeof EDIT;
      choices: NativePermissionChoicesV1['choices'];
      availability?: NativePermissionChoiceAvailabilityV1[];
      origin?: NativePermissionChoicesV1['origin'];
    }>
  >
> = {
  two: {
    request: EDIT,
    // The refusal accepts feedback, as an agent's "No, and say what to do instead" does (D21).
    choices: [once('once', 'Allow once'), { ...reject('reject', 'Reject'), allowsFeedback: true }],
  },
  four: {
    request: EDIT,
    choices: [
      once('once', 'Allow once'),
      session('session', 'Allow edits this session'),
      always('always', 'Always allow edits'),
      reject('reject', 'Reject'),
    ],
  },
  six: {
    request: {
      tool: 'WebFetch',
      arguments: {
        url: 'https://docs.stripe.com/webhooks/best-practices',
        prompt: 'Check how Stripe retries and orders events',
      },
    } as unknown as typeof EDIT,
    choices: [
      once('once', 'Allow once'),
      session('session', 'Allow docs.stripe.com for this session'),
      always('always', 'Always allow docs.stripe.com'),
      always(
        'readonly',
        'Always allow read-only fetches',
        'Any page, read only',
      ),
      reject('reject', 'Reject'),
      {
        ...reject(
          'stop',
          'Reject and stop this turn',
          'Stops and waits for you',
        ),
        decision: 'abort' as const,
      },
    ],
  },
  long: {
    request: {
      tool: 'Bash',
      arguments: { command: 'pnpm test --filter @harbor/billing' },
    } as unknown as typeof EDIT,
    choices: [
      session(
        'session',
        'Allow, and let the agent run any pnpm script in harbor-ledger for this session',
      ),
      once('once', 'Allow this command once'),
      reject('reject', 'Reject'),
    ],
  },
  shared: {
    request: EDIT,
    choices: [
      once('once', 'Allow once'),
      session('session', 'Allow edits this session'),
      always('always', 'Always allow edits'),
      reject('reject', 'Reject'),
    ],
    availability: [
      { choiceId: 'always', allowed: false, reason: 'owner_required' },
    ],
  },
  child: {
    request: EDIT,
    origin: { sessionId: 'dev-child-session', subagentId: 'schema-reviewer' },
    choices: [
      once('once', 'Allow once'),
      session('session', 'Allow edits this session'),
      reject('reject', 'Reject'),
    ],
  },
};

function buildRequest(
  state: Exclude<NativeApprovalSpecimenState, 'answered'>,
): PendingPermissionRequest {
  const offer = OFFERS[state];
  return {
    id: `dev-${state}`,
    turnId: 'dev-turn',
    tool: offer.request.tool,
    kind: 'permission',
    arguments: offer.request.arguments,
    createdAt: Date.UTC(2026, 10, 9, 13, 30),
    nativeChoices: {
      requirementId: `dev-${state}`,
      source: 'dev',
      ...(offer.origin ? { origin: offer.origin } : {}),
      choices: offer.choices,
    },
    ...(offer.availability
      ? { nativeChoiceAvailability: offer.availability }
      : {}),
  };
}

const ANSWERED = [
  {
    choiceId: 'once',
    status: 'approved' as const,
    choices: OFFERS.four.choices,
  },
  {
    choiceId: 'always',
    status: 'approved' as const,
    choices: OFFERS.six.choices,
  },
  {
    choiceId: 'reject',
    status: 'denied' as const,
    choices: OFFERS.four.choices,
  },
];

/**
 * The asking Session, client-local and removed on unmount, so the real card names who asks and where
 * ("Codex · nl2") exactly as it does in a live Session. It never becomes a server Session.
 */
function useSeededAskingSession(serverId: string): boolean {
  const [seeded, setSeeded] = React.useState(false);
  React.useEffect(() => {
    const session = createSessionFixture({
      id: SESSION_ID,
      serverId,
      active: true,
      metadata: {
        path: '/Users/dev/harbor-ledger',
        host: 'nl2',
        homeDir: '/Users/dev',
        machineId: 'dev-native-approvals',
        flavor: 'codex',
      } as Session['metadata'],
    });
    const state = storage.getState();
    // Never replace an existing local entry, even in a dev specimen.
    if (state.sessions[SESSION_ID]) return;
    storage.setState({ sessions: { ...state.sessions, [SESSION_ID]: session } });
    setSeeded(true);
    return () => {
      storage.setState((current) => {
        if (current.sessions[SESSION_ID] !== session) return current;
        const sessions = { ...current.sessions };
        delete sessions[SESSION_ID];
        return { sessions };
      });
    };
  }, [serverId]);
  return seeded;
}

/** Dev-only: the native-choice approval card and its answered line, credential-free for side-by-side lab QA. */
export function NativeApprovalSpecimen(
  props: Readonly<{ state: NativeApprovalSpecimenState }>,
) {
  const accountScope = useActiveServerAccountScope();
  const serverId = accountScope?.serverId ?? getActiveServerSnapshot().serverId;
  useSeededAskingSession(serverId);
  const source = React.useMemo(
    () =>
      createReadOnlySessionTranscriptSource({
        sessionId: SESSION_ID,
        messages: [],
        agentState: null,
        metadata: null,
        reducerState: null,
        interaction: { canSendMessages: true, canApprovePermissions: true },
        actions: {
          respondToPermission: () =>
            new Promise((resolve) => setTimeout(resolve, 1200)),
          answerUserAction: async () => {},
          abort: async () => {},
          submitMessage: async () => {},
        },
      }),
    [],
  );
  if (props.state === 'answered') {
    return (
      <View style={styles.answered}>
        {ANSWERED.map((answer) => (
          <PermissionAnswerOutcomeStatus
            key={answer.choiceId}
            permission={{
              id: `dev-answer-${answer.choiceId}`,
              status: answer.status,
              date: Date.UTC(2026, 10, 9, 13, 32),
              nativeChoices: {
                requirementId: 'dev',
                source: 'dev',
                choices: answer.choices,
              },
              nativeChoice: { requirementId: 'dev', choiceId: answer.choiceId },
            }}
          />
        ))}
      </View>
    );
  }
  return (
    <SessionTranscriptSourceProvider source={source}>
      <PermissionPromptCard
        key={props.state}
        request={buildRequest(props.state)}
        location={null}
        metadata={null}
        sessionId={SESSION_ID}
        serverId={serverId}
        canApprovePermissions
      />
    </SessionTranscriptSourceProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  answered: {
    alignItems: 'flex-start',
    gap: theme.space.s12,
  },
}));
