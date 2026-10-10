import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveTriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
  useSession,
  getStorage,
} from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
  readManagedCreationScopeRule,
  type ManagedCreationScopeRule,
} from '@/sync/ops/actions/managedCreationScopeBinding';
import {
  getSessionName,
  getSessionSubtitle,
} from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import { ManagedScopeRuleRow } from './ManagedMachineDetailSections';
import { formatRetentionDuration } from './managedRetentionPresentation';

const ACCOUNT_TRIGGERS = { scope: 'account_all' } as const;

/**
 * D23: a machine created for one session (or task) shows that scope and the rule chosen when it was
 * created, read from FIN's own trigger through the creation-scope owner. The row is a summary; it
 * opens the trigger where FIN edits it. Keep writes no trigger; Session birth provenance still names its source.
 */
export function ManagedCreationScopeRuleSection(
  props: Readonly<{ machine: ManagedMachineV1; serverId: string; binding?: ServerCredentialAccountScopeBinding }>,
) {
  const binding = props.binding;
  if (!binding?.isCurrent() || !areServerProfileIdentifiersEquivalent(binding.serverId, props.serverId)) return null;
  return <ScopeRuleReader machine={props.machine} serverId={props.serverId} accountId={binding.accountId} binding={binding} />;
}

function ScopeRuleReader(
  props: Readonly<{ machine: ManagedMachineV1; serverId: string; accountId: string; binding: ServerCredentialAccountScopeBinding }>,
) {
  const { sets, status } = useWorkflowTriggerSets(ACCOUNT_TRIGGERS, props.binding);
  const sourceSessionId = getStorage()(React.useCallback(state => {
    if (state.sessionLocalStateScope?.accountId !== props.accountId
      || !areServerProfileIdentifiersEquivalent(state.sessionLocalStateScope.serverId, props.serverId)) return null;
    const matches: string[] = [];
    for (const session of Object.values(state.sessions)) {
      if (session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, props.serverId)) continue;
      const parsed = SessionCreationCorrespondenceV1ReadSchema.safeParse(readSessionOwnerMetadataView(session)?.sessionCreationCorrespondenceV1);
      const birth = parsed.success ? parsed.data.recipe.managedCreation : undefined;
      // Birth Controller identity is immutable evidence, not current authority; Move does not rewrite it.
      if (birth?.homeId === props.machine.homeId && birth.managedId === props.machine.id) matches.push(session.id);
    }
    return matches.length === 1 ? matches[0]! : null;
  }, [props.serverId, props.accountId, props.machine.homeId, props.machine.id]));
  const rule = React.useMemo(
    () => readManagedCreationScopeRule(sets, props.machine),
    [sets, props.machine.homeId, props.machine.id],
  );
  const source = rule?.binding.source ?? (sourceSessionId ? { kind: 'session' as const, sessionId: sourceSessionId } : null);
  if (!source) return null;
  return (
    <ScopeRuleSection
      rule={rule ?? undefined}
      source={source}
      canEdit={props.accountId === props.machine.custodianAccountId && (Boolean(rule) || status === 'ready')}
      readStatus={status}
      machineName={props.machine.launch.name}
      serverId={props.serverId}
    />
  );
}

function describeScopeRule(
  rule: ManagedCreationScopeRule,
  name: string,
): string {
  const duration =
    rule.afterMs === undefined ? null : formatRetentionDuration(rule.afterMs);
  const effect =
    rule.effect === 'stop'
      ? duration
        ? t('managedRetention.scopeRuleStop', { name, duration })
        : t('managedRetention.scopeRuleStopIdle', { name })
      : duration
        ? t('managedRetention.scopeRuleDelete', { name, duration })
        : t('managedRetention.scopeRuleDeleteIdle', { name });
  // While its run waits the row leads with that; the chosen-at-creation note would only repeat history.
  return rule.waiting
    ? effect
    : t('managedRetention.scopeRuleChosen', { rule: effect, name });
}

function ScopeRuleSection(
  props: Readonly<{
    rule?: ManagedCreationScopeRule;
    source: ManagedCreationScopeRule['binding']['source'];
    canEdit: boolean;
    readStatus: 'loading' | 'ready' | 'failed';
    machineName: string;
    serverId: string;
  }>,
) {
  const router = useRouter();
  const { rule } = props;
  const source = props.source;
  const summary = rule ? describeScopeRule(rule, props.machineName) : props.readStatus === 'loading' ? t('common.loading')
    : props.readStatus === 'failed' ? t('managedMachines.options.unavailable') : t('common.keep');
  const openRule = () =>
    router.push(
      resolveTriggerEditorHref({
        automationId: rule?.binding.automationId,
        serverId: props.serverId,
        scopeSessionId: source.kind === 'session' ? source.sessionId : null,
      }),
    );
  return (
    <ItemGroup
      title={t(
        source.kind === 'session'
          ? 'managedRetention.scopeSessionTitle'
          : 'managedRetention.scopeTaskTitle',
      )}
      description={t(
        source.kind === 'session'
          ? 'managedRetention.createdForSession'
          : 'managedRetention.createdForTask',
      )}
    >
      {source.kind === 'session' ? (
        <ScopeSessionRow
          sessionId={source.sessionId}
          serverId={props.serverId}
        />
      ) : null}
      <ManagedScopeRuleRow
        testID="managed-machine.scope-rule"
        rule={{
          scope: source.kind === 'session' ? 'session' : 'task',
          summary,
          waiting: rule?.waiting,
          onOpen: props.canEdit ? openRule : undefined,
        }}
      />
    </ItemGroup>
  );
}

function ScopeSessionRow(
  props: Readonly<{ sessionId: string; serverId: string }>,
) {
  const { theme } = useUnistyles();
  const session = useSession(props.sessionId, props.serverId);
  const navigateToSession = useNavigateToSession();
  // A session this device has not loaded stays reachable through its rule's editor; no placeholder row.
  if (!session) return null;
  return (
    <Item
      testID="managed-machine.scope-session"
      title={getSessionName(session, props.serverId)}
      subtitle={getSessionSubtitle(session, props.serverId)}
      icon={
        <Icon
          name="chat-circle-dots"
          size={20}
          color={theme.colors.text.secondary}
        />
      }
      onPress={() =>
        navigateToSession(props.sessionId, { serverId: props.serverId })
      }
    />
  );
}
