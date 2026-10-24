import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type {
  CodeIntelligenceActivityEventV1,
  CodeIntelligenceCommitV1,
  CodeIntelligenceRepositoryV1,
  CodeIntelligenceSettingsV1,
  ObservedAgentSessionV1,
} from '@happier-dev/protocol';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines } from '@/sync/domains/state/storage';
import {
  fetchCodeIntelligenceSettings,
  registerCodeIntelligenceRepository,
  requestCodeIntelligenceCommitAnalysis,
  saveCodeIntelligenceSettings,
} from '@/sync/domains/codeIntelligence/codeIntelligenceRpc';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import {
  ANALYSIS_PROVIDER_BRANDS,
  describeActivityEvent,
  formatAgentName,
  formatAnalysisState,
  formatBilling,
  formatChangeKind,
  formatSessionStatus,
  formatSeverity,
  resolveObservedAgentId,
} from './presentCodeIntelligence';
import { useCodeIntelligenceFeed } from './useCodeIntelligenceFeed';

type MachineTarget = Readonly<{ serverId: string; machineId: string }>;

/** Rows shown per section; the full history stays in the daemon's local store. */
const VISIBLE_COMMITS = 20;
const VISIBLE_EVENTS = 40;

/** A short, stable provider id for a model id of any length (FNV-1a). */
function hashProviderModel(modelId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < modelId.length; index += 1) {
    hash ^= modelId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function CodeIntelligenceScreen() {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const serverId = getActiveServerSnapshot().serverId;
  const onlineMachines = React.useMemo(() => machines.filter((machine) => isMachineOnline(machine)), [machines]);
  const [machineId, setMachineId] = React.useState<string>(() => onlineMachines[0]?.id ?? '');
  const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);

  // A selected machine stays selected while it is briefly offline, so its last snapshot stays on
  // screen; only a machine that is gone entirely (or none chosen yet) falls back to an online one.
  React.useEffect(() => {
    if (machineId && machines.some((machine) => machine.id === machineId)) return;
    const fallback = onlineMachines[0]?.id ?? '';
    if (fallback !== machineId) setMachineId(fallback);
  }, [machineId, machines, onlineMachines]);

  const target = React.useMemo<MachineTarget | null>(
    () => (serverId && machineId ? { serverId, machineId } : null),
    [machineId, serverId],
  );
  const feed = useCodeIntelligenceFeed(target);
  const settings = useCodeIntelligenceSettings(target, feed.phase);

  const machineItems = React.useMemo(() => onlineMachines.map((machine) => ({
    id: machine.id,
    title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
    subtitle: machine.metadata?.host || undefined,
  })), [onlineMachines]);

  if (!target) {
    return (
      <ItemList>
        <ConstrainedScreenContent>
          <ItemGroup title={t('codeIntelligence.title')} footer={t('codeIntelligence.noMachines')}>{null}</ItemGroup>
        </ConstrainedScreenContent>
      </ItemList>
    );
  }

  const view = feed.view;
  return (
    <ItemList>
      <ConstrainedScreenContent>
        <ItemGroup
          title={t('codeIntelligence.title')}
          footer={feed.phase === 'unreachable' ? t('codeIntelligence.unreachable') : t('codeIntelligence.privacyFooter')}
        >
          {/* Offered whenever another machine can be chosen, including away from an offline selection. */}
          {machineItems.some((item) => item.id !== machineId) ? (
            <DropdownMenu
              open={machineMenuOpen}
              onOpenChange={setMachineMenuOpen}
              selectedId={machineId}
              items={machineItems}
              onSelect={(nextId) => {
                setMachineId(nextId);
                setMachineMenuOpen(false);
              }}
              itemTrigger={{ title: t('codeIntelligence.changeMachine') }}
            />
          ) : null}
          <Item
            title={feed.phase === 'disabled' ? t('codeIntelligence.offTitle') : t('codeIntelligence.watching')}
            subtitle={feed.phase === 'disabled'
              ? t('codeIntelligence.offSubtitle')
              : view?.worker.lastSweepAtMs ? t('codeIntelligence.lastChecked', { time: formatTime(view.worker.lastSweepAtMs) }) : undefined}
            subtitleLines={0}
            icon={<Icon name="pulse" size={ICON_SIZE.lg} color={feed.phase === 'ready' ? theme.colors.state.success.foreground : theme.colors.text.secondary} />}
            rightElement={settings.value ? (
              <Switch
                value={settings.value.enabled}
                onValueChange={(enabled) => settings.update((current) => ({ ...current, enabled }), feed.refresh)}
                accessibilityLabel={t('codeIntelligence.watchToggle')}
              />
            ) : null}
          />
        </ItemGroup>

        {feed.phase !== 'disabled' && view ? (
          <>
            <RepositoriesGroup
              repositories={view.repositories}
              sessions={view.sessions}
              settings={settings.value}
              onToggleRemoteReview={(repositoryId) => settings.update((current) => {
                const allowed = new Set(current.remoteAnalysis.allowedRepositoryIds);
                if (allowed.has(repositoryId)) allowed.delete(repositoryId);
                else allowed.add(repositoryId);
                return { ...current, remoteAnalysis: { ...current.remoteAnalysis, allowedRepositoryIds: [...allowed] } };
              })}
            />
            <AddRepositoryGroup
              onAdd={async () => {
                const path = await Modal.prompt(t('codeIntelligence.addRepository'), t('codeIntelligence.addRepositoryPrompt'));
                if (!path?.trim()) return;
                const result = await registerCodeIntelligenceRepository(target, path.trim()).catch(() => null);
                if (!result?.ok) {
                  const message = !result || result.errorCode === 'internal_error' || result.errorCode === 'code_intelligence_disabled'
                    ? t('codeIntelligence.addRepositoryUnreachable')
                    : result.errorCode === 'path_not_allowed'
                      ? t('codeIntelligence.addRepositoryDenied')
                      : t('codeIntelligence.addRepositoryFailed');
                  Modal.alert(t('codeIntelligence.addRepository'), message);
                }
                feed.refresh();
              }}
            />
            <AgentsGroup sessions={view.sessions} />
            <CommitsGroup
              commits={view.commits}
              onReviewAgain={async (commit) => {
                await requestCodeIntelligenceCommitAnalysis(target, { repositoryId: commit.repositoryId, sha: commit.sha }).catch(() => null);
                feed.refresh();
              }}
            />
            {settings.value ? <RemoteReviewGroup settings={settings.value} update={settings.update} /> : null}
            <ActivityGroup events={view.events} />
          </>
        ) : null}
      </ConstrainedScreenContent>
    </ItemList>
  );
}

/**
 * Settings are read once per machine and written only on explicit user intent. Edits are queued and
 * each applies to the latest value (optimistically), so two quick toggles never overwrite each
 * other; a reply for a machine the user has left is dropped.
 */
function useCodeIntelligenceSettings(target: MachineTarget | null, phase: string) {
  const [value, setValue] = React.useState<CodeIntelligenceSettingsV1 | null>(null);
  const serverId = target?.serverId;
  const machineId = target?.machineId;
  const targetKey = `${serverId ?? ''}/${machineId ?? ''}`;
  const targetKeyRef = React.useRef(targetKey);
  // Updated on commit, never during render: a render React discards must not retarget pending saves.
  React.useLayoutEffect(() => {
    targetKeyRef.current = targetKey;
  }, [targetKey]);
  const valueRef = React.useRef<CodeIntelligenceSettingsV1 | null>(null);
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  const daemonReachable = phase !== 'loading' && phase !== 'unreachable';

  const apply = React.useCallback((next: CodeIntelligenceSettingsV1 | null) => {
    valueRef.current = next;
    setValue(next);
  }, []);

  React.useEffect(() => {
    apply(null);
    if (!serverId || !machineId || !daemonReachable) return;
    let cancelled = false;
    void fetchCodeIntelligenceSettings({ serverId, machineId })
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apply, daemonReachable, machineId, serverId]);

  const update = React.useCallback((change: (current: CodeIntelligenceSettingsV1) => CodeIntelligenceSettingsV1, after?: () => void) => {
    if (!serverId || !machineId) return;
    const requestedKey = `${serverId}/${machineId}`;
    queueRef.current = queueRef.current.then(async () => {
      const current = valueRef.current;
      if (!current || targetKeyRef.current !== requestedKey) return;
      const next = change(current);
      apply(next);
      try {
        const saved = await saveCodeIntelligenceSettings({ serverId, machineId }, next);
        if (targetKeyRef.current !== requestedKey) return;
        apply(saved);
        after?.();
      } catch {
        if (targetKeyRef.current !== requestedKey) return;
        apply(current);
        Modal.alert(t('codeIntelligence.title'), t('codeIntelligence.saveFailed'));
      }
    });
  }, [apply, machineId, serverId]);

  return { value, update };
}

const RepositoriesGroup = React.memo(function RepositoriesGroup(props: Readonly<{
  repositories: readonly CodeIntelligenceRepositoryV1[];
  sessions: readonly ObservedAgentSessionV1[];
  settings: CodeIntelligenceSettingsV1 | null;
  onToggleRemoteReview: (repositoryId: string) => void;
}>) {
  const { theme } = useUnistyles();
  return (
    <ItemGroup
      title={t('codeIntelligence.repositories')}
      footer={props.repositories.length === 0 ? t('codeIntelligence.repositoriesEmpty') : undefined}
    >
      {props.repositories.map((repository) => {
        const activeAgents = props.sessions.filter((session) =>
          session.repositoryId === repository.repositoryId && (session.status === 'running' || session.status === 'active_recently')).length;
        const remoteAllowed = props.settings?.remoteAnalysis.allowedRepositoryIds.includes(repository.repositoryId) ?? false;
        return (
          <Item
            key={repository.repositoryId}
            title={repository.displayName}
            subtitle={t('codeIntelligence.repositorySummary', { worktrees: repository.worktrees.length, agents: activeAgents })}
            icon={<Icon name="folder" size={ICON_SIZE.lg} color={theme.colors.accent.blue} />}
            rightElement={props.settings ? (
              <Switch
                value={remoteAllowed}
                onValueChange={() => props.onToggleRemoteReview(repository.repositoryId)}
                accessibilityLabel={t('codeIntelligence.allowRemoteReview', { name: repository.displayName })}
              />
            ) : null}
          />
        );
      })}
    </ItemGroup>
  );
});

const AddRepositoryGroup = React.memo(function AddRepositoryGroup(props: Readonly<{ onAdd: () => void }>) {
  const { theme } = useUnistyles();
  return (
    <ItemGroup>
      <Item
        title={t('codeIntelligence.addRepository')}
        icon={<Icon name="plus-circle" size={ICON_SIZE.lg} color={theme.colors.text.link} />}
        onPress={props.onAdd}
      />
    </ItemGroup>
  );
});

const AgentsGroup = React.memo(function AgentsGroup(props: Readonly<{ sessions: readonly ObservedAgentSessionV1[] }>) {
  const { theme } = useUnistyles();
  return (
    <ItemGroup title={t('codeIntelligence.agents')} footer={props.sessions.length === 0 ? t('codeIntelligence.agentsEmpty') : t('codeIntelligence.agentsFooter')}>
      {props.sessions.map((session) => {
        const agentId = resolveObservedAgentId(session.providerId);
        return (
          <Item
            key={session.id}
            title={session.title ?? formatAgentName(session.providerId)}
            subtitle={[
              formatAgentName(session.providerId),
              session.branch ? t('codeIntelligence.onBranch', { branch: session.branch }) : null,
              formatTime(session.lastActivityAtMs),
            ].filter(Boolean).join(' · ')}
            detail={formatSessionStatus(session.status)}
            icon={agentId
              ? <AgentIcon agentId={agentId} size={ICON_SIZE.lg} />
              : <Icon name="robot" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
          />
        );
      })}
    </ItemGroup>
  );
});

const CommitsGroup = React.memo(function CommitsGroup(props: Readonly<{
  commits: readonly CodeIntelligenceCommitV1[];
  onReviewAgain: (commit: CodeIntelligenceCommitV1) => Promise<void> | void;
}>) {
  return (
    <ItemGroup title={t('codeIntelligence.commits')} footer={props.commits.length === 0 ? t('codeIntelligence.commitsEmpty') : undefined}>
      {props.commits.slice(0, VISIBLE_COMMITS).map((commit) => (
        <CommitRow key={`${commit.repositoryId}:${commit.sha}`} commit={commit} onReviewAgain={props.onReviewAgain} />
      ))}
    </ItemGroup>
  );
});

const CommitRow = React.memo(function CommitRow(props: Readonly<{
  commit: CodeIntelligenceCommitV1;
  onReviewAgain: (commit: CodeIntelligenceCommitV1) => Promise<void> | void;
}>) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const [reviewRequested, setReviewRequested] = React.useState(false);
  const { commit } = props;
  const reviewInProgress = reviewRequested || commit.analysis.status === 'analyzing';
  const findings = commit.analysis.findings;
  const riskColor = commit.analysis.riskLevel === 'high' || commit.analysis.riskLevel === 'critical'
    ? theme.colors.state.danger.foreground
    : commit.analysis.riskLevel === 'medium' ? theme.colors.state.warning.foreground : theme.colors.text.secondary;
  return (
    <>
      <Item
        title={commit.subject || commit.sha.slice(0, 8)}
        subtitle={`${commit.sha.slice(0, 8)} · ${t('codeIntelligence.commitDetail', { files: commit.changedFileCount ?? commit.changedFiles.length, symbols: commit.changedSymbols.length })}`}
        detail={formatAnalysisState(commit.analysis)}
        icon={<Icon name="git-commit" size={ICON_SIZE.lg} color={riskColor} />}
        onPress={() => setExpanded((value) => !value)}
        accessibilityState={{ expanded }}
      />
      {expanded ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
          {commit.plausibleSessionIds.length > 0 ? (
            <Text style={{ color: theme.colors.text.secondary }}>{t('codeIntelligence.possibleSession')}</Text>
          ) : null}
          {commit.changedSymbols.slice(0, 12).map((symbol) => (
            <Text key={`${symbol.filePath}:${symbol.startLine}:${symbol.name}`} style={{ color: theme.colors.text.secondary }}>
              {`${formatChangeKind(symbol.changeKind)} · ${symbol.name} · ${symbol.filePath}:${symbol.startLine}`}
            </Text>
          ))}
          {commit.analysis.summary ? <Text style={{ color: theme.colors.text.primary }}>{commit.analysis.summary}</Text> : null}
          {findings.map((finding) => (
            <View key={finding.findingId} style={{ gap: 2 }}>
              <Text style={{ color: theme.colors.text.primary }}>
                {`${formatSeverity(finding.severity)} · ${finding.category}${finding.filePath ? ` · ${finding.filePath}${finding.line ? `:${finding.line}` : ''}` : ''}`}
              </Text>
              <Text style={{ color: theme.colors.text.secondary }}>{finding.explanation}</Text>
              {finding.suggestedCorrection ? <Text style={{ color: theme.colors.text.secondary }}>{finding.suggestedCorrection}</Text> : null}
              <Text style={{ color: theme.colors.text.tertiary }}>{t('codeIntelligence.findingSuspected')}</Text>
            </View>
          ))}
          <Item
            title={t('codeIntelligence.reviewAgain')}
            disabled={reviewInProgress}
            loading={reviewInProgress}
            onPress={() => {
              setReviewRequested(true);
              void Promise.resolve(props.onReviewAgain(commit)).finally(() => setReviewRequested(false));
            }}
            density="compact"
          />
        </View>
      ) : null}
    </>
  );
});

const RemoteReviewGroup = React.memo(function RemoteReviewGroup(props: Readonly<{
  settings: CodeIntelligenceSettingsV1;
  update: (change: (current: CodeIntelligenceSettingsV1) => CodeIntelligenceSettingsV1) => void;
}>) {
  const { theme } = useUnistyles();
  const remote = props.settings.remoteAnalysis;
  return (
    <ItemGroup title={t('codeIntelligence.remoteReview')} footer={t('codeIntelligence.remoteReviewFooter')}>
      <Item
        title={t('codeIntelligence.remoteReview')}
        subtitle={t('codeIntelligence.remoteReviewSubtitle')}
        subtitleLines={0}
        icon={<Icon name="shield-check" size={ICON_SIZE.lg} color={theme.colors.state.success.foreground} />}
        rightElement={(
          <Switch
            value={remote.enabled}
            onValueChange={(enabled) => props.update((current) => ({ ...current, remoteAnalysis: { ...current.remoteAnalysis, enabled } }))}
            accessibilityLabel={t('codeIntelligence.remoteReview')}
          />
        )}
      />
      {remote.providers.map((provider) => (
        <Item
          key={provider.id}
          title={provider.modelId}
          subtitle={`${ANALYSIS_PROVIDER_BRANDS[provider.kind]} · ${formatBilling(provider.billing)}`}
          detail={t('codeIntelligence.removeModel')}
          onPress={() => props.update((current) => ({
            ...current,
            remoteAnalysis: { ...current.remoteAnalysis, providers: current.remoteAnalysis.providers.filter((candidate) => candidate.id !== provider.id) },
          }))}
        />
      ))}
      <Item
        title={t('codeIntelligence.addGroqModel')}
        subtitle={t('codeIntelligence.addGroqModelSubtitle')}
        subtitleLines={0}
        icon={<Icon name="plus-circle" size={ICON_SIZE.lg} color={theme.colors.text.link} />}
        onPress={async () => {
          const modelId = (await Modal.prompt(t('codeIntelligence.addGroqModel'), t('codeIntelligence.modelIdPrompt')))?.trim();
          if (!modelId) return;
          const apiKey = (await Modal.prompt(t('codeIntelligence.addGroqModel'), t('codeIntelligence.apiKeyPrompt'), { inputType: 'secure-text' }))?.trim();
          if (!apiKey) return;
          const groqProviderId = `groq-${hashProviderModel(modelId)}`;
          props.update((current) => ({
            ...current,
            remoteAnalysis: {
              ...current.remoteAnalysis,
              // Adding a model that is already configured replaces it (for example with a new key).
              providers: [
                ...current.remoteAnalysis.providers.filter((provider) => provider.id !== groqProviderId),
                {
                  id: groqProviderId,
                  kind: 'groq',
                  enabled: true,
                  baseUrl: null,
                  apiKey: { _isSecretValue: true, value: apiKey },
                  modelId,
                  billing: 'free',
                  inputPricePerMillionUsd: null,
                  outputPricePerMillionUsd: null,
                },
              ],
            },
          }));
        }}
      />
    </ItemGroup>
  );
});

const ActivityGroup = React.memo(function ActivityGroup(props: Readonly<{ events: readonly CodeIntelligenceActivityEventV1[] }>) {
  return (
    <ItemGroup title={t('codeIntelligence.activity')} footer={props.events.length === 0 ? t('codeIntelligence.activityEmpty') : undefined}>
      {props.events.slice(0, VISIBLE_EVENTS).map((event) => (
        <Item key={event.seq} title={describeActivityEvent(event)} detail={formatTime(event.atMs)} density="compact" />
      ))}
    </ItemGroup>
  );
});
