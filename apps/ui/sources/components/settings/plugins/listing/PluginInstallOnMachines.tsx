import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import {
  listPluginInstallConsentFacts,
  readPluginInstallApprovalChange,
} from '@/components/approvals/pluginInstallApprovalFacts';
import { readApprovalActionTitle } from '@/components/approvals/approvalRequestTitle';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { readApprovalAutomaticChecksShown } from '@/components/approvals/ApprovalAutomaticChecks';
import { showApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useApprovalReview } from '@/components/approvals/useApprovalReview';
import { MachineSetupReviewFooter } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import { t } from '@/text';

import type {
  PluginInstallReviewRow,
  PluginInstallReviewSet,
} from '../model/usePluginInstallReviewSet';
import type { PluginSettingsScreenState } from '../model/usePluginSettingsScreenState';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

type Decision = 'approve' | 'reject' | 'cancel';
type ConsentFact = ReturnType<typeof listPluginInstallConsentFacts>[number];

/** What one Machine's mounted review offers the combined review: read at the press, never cached as consent. */
type MachineReviewController = Readonly<{
  target: MachineAdministrationTargetV1;
  /** Its own Approve is shown and enabled now, and it waits on this person (not on a requester). */
  approvable: boolean;
  open: boolean;
  superseded: boolean;
  /** That review's own request-bound decision. */
  decide: (decision: Decision) => Promise<void>;
  /** The consent facts its own Artifact evaluated; empty when it has none to show. */
  facts: readonly ConsentFact[];
}>;

type SheetProps = Readonly<{
  name: string;
  candidates: readonly MachineAdministrationCandidateV1[];
  initialTarget: MachineAdministrationTargetV1 | null;
  review: PluginInstallReviewSet | null;
  run: (targets: readonly MachineAdministrationTargetV1[]) => Promise<void>;
  onClosed: () => void;
}>;

/**
 * The consent facts every Machine that reported facts reported identically, read once above the Machines.
 * It needs two such Machines: one Machine's facts are its own. Anything that differs (or that one Machine
 * lacks) stays in each Machine's own section, so no Machine is ever represented by another's facts (C2).
 */
export function readSharedConsentFacts(
  factsByMachine: readonly (readonly ConsentFact[])[],
): readonly ConsentFact[] {
  const reporting = factsByMachine.filter((facts) => facts.length > 0);
  const [first, ...rest] = reporting;
  if (!first || rest.length === 0) return [];
  return first.filter((fact) =>
    rest.every((facts) =>
      facts.some(
        (other) =>
          other.key === fact.key &&
          other.title === fact.title &&
          other.value === fact.value,
      ),
    ),
  );
}

const sameFact = (a: ConsentFact, b: ConsentFact) =>
  a.key === b.key && a.title === b.title && a.value === b.value;

const targetKey = (target: MachineAdministrationTargetV1) =>
  JSON.stringify([target.serverIdentityId, target.machineId]);
const SUPERSEDED_CODES: ReadonlySet<string> = new Set([
  'plugin_change_superseded',
  'approval_stale',
]);

/**
 * Choose Machines and install in one press. Each Machine shows its outcome or any
 * separate approval the receiver requires, beside its name and Home.
 */
export function usePluginInstallOnMachines(
  state: PluginSettingsScreenState,
  entry: PluginMarketplaceCatalogEntry | null,
) {
  const { runCatalogInstallOnMachines } = state;
  // Machines that still exist; an unreachable one keeps its place, says why and cannot be chosen.
  const allCandidates = state.administrationTargetSelection.candidates;
  const candidates = React.useMemo(
    () => allCandidates.filter((candidate) => candidate.availability !== 'missing' && candidate.availability !== 'replaced'),
    [allCandidates],
  );
  const initialTarget =
    state.administrationTargetSelection.state.kind === 'unselected'
      ? null
      : state.administrationTargetSelection.state.target;
  const pluginId = entry?.id ?? null;
  const sourceId = entry?.sourceId ?? null;
  const run = React.useCallback(
    async (targets: readonly MachineAdministrationTargetV1[]) => {
      if (pluginId && sourceId)
        await runCatalogInstallOnMachines({ pluginId, sourceId }, targets);
    },
    [pluginId, runCatalogInstallOnMachines, sourceId],
  );
  const input = React.useMemo(
    (): PluginInstallOnMachinesSheetInput => ({
      name: entry?.title ?? pluginId ?? '',
      candidates,
      initialTarget,
      review:
        state.pluginInstallReview?.pluginId === pluginId
          ? state.pluginInstallReview
          : null,
      run,
    }),
    [
      candidates,
      entry?.title,
      initialTarget,
      pluginId,
      run,
      state.pluginInstallReview,
    ],
  );
  const open = usePluginInstallOnMachinesSheet(input);
  return { open, available: entry?.installable === true && candidates.length > 1 };
}

export type PluginInstallOnMachinesSheetInput = Omit<SheetProps, 'onClosed'>;

/** Presents the combined review as its sheet, kept current with `input` while shown; the caller memoizes `input`. */
export function usePluginInstallOnMachinesSheet(
  input: PluginInstallOnMachinesSheetInput,
) {
  const modalId = React.useRef<string | null>(null);
  const onClosed = React.useCallback(() => {
    modalId.current = null;
  }, []);
  const props = React.useMemo(
    (): SheetProps => ({ ...input, onClosed }),
    [input, onClosed],
  );
  const propsRef = React.useRef(props);
  propsRef.current = props;
  React.useEffect(() => {
    if (modalId.current)
      Modal.update<SheetProps & CustomModalInjectedProps>(
        modalId.current,
        props,
      );
  }, [props]);
  // The listing that asked owns the sheet: leaving it withdraws the sheet, never the pending approvals.
  React.useEffect(
    () => () => {
      if (modalId.current) Modal.hide(modalId.current);
      modalId.current = null;
    },
    [],
  );
  const open = React.useCallback(() => {
    if (modalId.current) return;
    modalId.current = Modal.show({
      component: PluginInstallOnMachinesSheet,
      props: propsRef.current,
      onRequestClose: () => {
        modalId.current = null;
      },
      // A stray click outside never closes a consent; Close, Escape and the footer do.
      closeOnBackdrop: false,
      chrome: {
        kind: 'card',
        title: installTitle(propsRef.current.name),
        testID: 'settings.plugins.installOnMachines.modal',
        phonePresentation: 'sheet',
        scrollHost: 'bounded',
        bodyScroll: 'auto',
        dimensions: { size: 'md', maxHeightRatio: 0.9 },
      },
    });
  }, []);
  return open;
}

function installTitle(name: string): string {
  const action = readApprovalActionTitle('plugins.install');
  return action ? `${action} · ${name}` : name;
}

export function PluginInstallOnMachinesSheet(
  props: SheetProps & CustomModalInjectedProps,
) {
  const { onClose, onClosed, review, run, setChrome } = props;
  const [phase, setPhase] = React.useState<'choose' | 'review'>('choose');
  const [chosen, setChosen] = React.useState<
    ReadonlyMap<string, MachineAdministrationTargetV1>
  >(() =>
    props.initialTarget &&
    props.candidates.some(
      (candidate) =>
        candidate.availability === 'online' &&
        targetKey(candidate.target) === targetKey(props.initialTarget!),
    )
      ? new Map([[targetKey(props.initialTarget), props.initialTarget]])
      : new Map(),
  );
  const [running, setRunning] = React.useState(false);
  const [deciding, setDeciding] = React.useState(false);
  const controllers = React.useRef(new Map<string, MachineReviewController>());
  const [summary, setSummary] = React.useState({
    approvable: 0,
    open: 0,
    superseded: 0,
  });
  const [sharedFacts, setSharedFacts] = React.useState<readonly ConsentFact[]>(
    [],
  );
  const register = React.useCallback(
    (artifactId: string, controller: MachineReviewController | null) => {
      if (controller) controllers.current.set(artifactId, controller);
      else controllers.current.delete(artifactId);
      const values = [...controllers.current.values()];
      const next = {
        approvable: values.filter((value) => value.approvable && value.open)
          .length,
        open: values.filter((value) => value.open).length,
        superseded: values.filter((value) => value.superseded).length,
      };
      setSummary((previous) =>
        previous.approvable === next.approvable &&
        previous.open === next.open &&
        previous.superseded === next.superseded
          ? previous
          : next,
      );
      const shared = readSharedConsentFacts(values.map((value) => value.facts));
      setSharedFacts((previous) =>
        previous.length === shared.length &&
        previous.every((fact, index) => sameFact(fact, shared[index]!))
          ? previous
          : shared,
      );
    },
    [],
  );
  const close = React.useCallback(() => {
    onClosed();
    onClose();
  }, [onClose, onClosed]);
  const startInstall = React.useCallback(
    async (targets: readonly MachineAdministrationTargetV1[]) => {
      if (running || targets.length === 0) return;
      setPhase('review');
      setRunning(true);
      try {
        await run(targets);
      } finally {
        setRunning(false);
      }
    },
    [run, running],
  );
  // An Account switch or a withdrawn listing retires a shown set: nothing is left to confirm here.
  // (The set reaches this sheet a render after its run settles, so only a set that was shown can retire.)
  const shownReview = React.useRef(false);
  if (review) shownReview.current = true;
  const retired = phase === 'review' && !running && review === null && shownReview.current;
  React.useEffect(() => {
    if (retired) close();
  }, [close, retired]);
  const install = React.useCallback(async () => {
    if (deciding) return;
    // The set is read at the press: only rows shown now, still open and approvable by this person.
    const eligible = [...controllers.current.values()].filter(
      (controller) => controller.approvable && controller.open,
    );
    if (eligible.length === 0) return;
    setDeciding(true);
    try {
      await Promise.all(
        eligible.map((controller) => controller.decide('approve')),
      );
    } finally {
      setDeciding(false);
    }
  }, [deciding]);
  const withdraw = React.useCallback(async () => {
    const open = [...controllers.current.values()].filter(
      (controller) => controller.open,
    );
    await Promise.all(open.map((controller) => controller.decide('cancel')));
    close();
  }, [close]);
  const reviewAgain = React.useCallback(() => {
    const targets = [...controllers.current.values()]
      .filter((controller) => controller.superseded)
      .map((controller) => controller.target);
    setChosen(new Map(targets.map((target) => [targetKey(target), target])));
    setPhase('choose');
  }, []);

  const chosenTargets = React.useMemo(() => [...chosen.values()], [chosen]);
  const needsApproval = phase === 'review' && !running && summary.open > 0;
  const reviewNote = needsApproval ? t('settingsPlugins.multiInstall.footerNote') : null;
  const subtitle = needsApproval ? t('settingsPlugins.multiInstall.reviewDescription') : null;
  const footer = React.useMemo(() => {
    if (phase === 'choose') {
      return (
        <MachineSetupReviewFooter
          onCancel={close}
          cancelTestID="settings.plugins.installOnMachines.cancel"
          note={null}
          primary={{
            label: t('settingsPlugins.installAndTrust'),
            testID: 'settings.plugins.installOnMachines.submit',
            disabled: chosenTargets.length === 0,
            onPress: () => {
              void startInstall(chosenTargets);
            },
          }}
        />
      );
    }
    if (needsApproval) {
      const label =
        summary.approvable === 1
          ? t('capabilities.store.softwarePage.installOnOne', {
              machine: firstApprovableMachine(review),
            })
          : t('capabilities.store.softwarePage.installOnMany', {
              count: summary.approvable,
            });
      return (
        <MachineSetupReviewFooter
          onCancel={() => {
            void withdraw();
          }}
          cancelTestID="settings.plugins.installOnMachines.cancel"
          note={reviewNote}
          primary={{
            label,
            testID: 'settings.plugins.installOnMachines.install',
            loading: deciding,
            disabled: deciding || summary.approvable === 0,
            onPress: () => {
              void install();
            },
          }}
        />
      );
    }
    return (
      <MachineSetupReviewFooter
        onCancel={close}
        cancelTestID="settings.plugins.installOnMachines.close"
        cancelLabel={t('common.close')}
        note={null}
        {...(!running && summary.superseded > 0
          ? {
              primary: {
                label: t('settingsPlugins.multiInstall.reviewAgain'),
                testID: 'settings.plugins.installOnMachines.reviewAgain',
                onPress: reviewAgain,
              },
            }
          : {})}
      />
    );
  }, [
    chosenTargets,
    close,
    deciding,
    install,
    needsApproval,
    phase,
    review,
    reviewAgain,
    reviewNote,
    running,
    startInstall,
    summary,
    withdraw,
  ]);
  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: installTitle(props.name),
      subtitle,
      footer,
      phonePresentation: 'sheet' as const,
      dimensions: { size: 'md' as const, maxHeightRatio: 0.9 },
    }),
    [footer, props.name, subtitle],
  );
  useModalCardChrome(setChrome, chrome);
  // Without card chrome (an embedding host), the footer ends the body.
  const inlineFooter = setChrome ? null : footer;

  if (phase === 'choose') {
    return (
      <SheetBody testID="settings.plugins.installOnMachines.choose">
        <ItemGroup title={t('settingsPlugins.multiInstall.machinesTitle')}>
          {props.candidates.map((candidate) => {
            const key = targetKey(candidate.target);
            const online = candidate.availability === 'online';
            const on = chosen.has(key);
            const reason = online
              ? null
              : candidate.availability === 'offline'
                ? t('capabilities.store.softwarePage.targetOffline')
                : candidate.availability === 'unknown'
                  ? t('capabilities.store.softwarePage.targetUnknown')
                  : t('common.unavailable');
            return (
              <Item
                key={key}
                testID={`settings.plugins.installOnMachines.target.${candidate.target.machineId}`}
                title={candidate.displayName}
                subtitle={
                  reason
                    ? `${candidate.serverLabel} · ${reason}`
                    : candidate.serverLabel
                }
                showChevron={false}
                rightElement={
                  <Switch
                    testID={`settings.plugins.installOnMachines.target.${candidate.target.machineId}.switch`}
                    value={on}
                    disabled={!online && !on}
                    accessibilityLabel={candidate.displayName}
                    onValueChange={(value) =>
                      setChosen((previous) => {
                        const next = new Map(previous);
                        if (value) next.set(key, candidate.target);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                }
              />
            );
          })}
        </ItemGroup>
        {inlineFooter}
      </SheetBody>
    );
  }
  return (
    <SheetBody testID="settings.plugins.installOnMachines.review">
      {review && sharedFacts.length > 0 ? (
        <ItemGroup
          testID="settings.plugins.installOnMachines.shared"
          title={t('settingsPlugins.multiInstall.sharedTitle')}
        >
          {sharedFacts.map((fact) => (
            <Item
              key={fact.key}
              title={fact.title}
              subtitle={fact.value}
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}
      {review
        ? review.rows.map((row) =>
            row.kind === 'approval' ? (
              <MachineApprovalReview
                key={row.artifactId}
                row={row}
                register={register}
                sharedFacts={sharedFacts}
              />
            ) : (
              <MachineSettledResult key={targetKey(row.target)} row={row} />
            ),
          )
        : chosenTargets.map((target) => {
            const candidate = props.candidates.find(
              (entry) => targetKey(entry.target) === targetKey(target),
            );
            return (
              <ItemGroup
                key={targetKey(target)}
                title={candidate?.displayName ?? target.machineId}
                description={candidate?.serverLabel}
              >
                <Item
                  title={t('settingsPlugins.multiInstall.checking')}
                  loading
                  mode="info"
                  showChevron={false}
                />
              </ItemGroup>
            );
          })}
      {inlineFooter}
    </SheetBody>
  );
}

/** The sheet's body reads as page sections (title, then the description above the rows), inside the card's inset. */
function SheetBody(props: Readonly<{ testID: string; children: React.ReactNode }>) {
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID={props.testID} style={styles.body}>
        {props.children}
      </View>
    </ListPresentationProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
}));

function firstApprovableMachine(review: PluginInstallReviewSet | null): string {
  return (
    review?.rows.find((row) => row.kind === 'approval')?.targetLabel.machine ??
    ''
  );
}

/** Show the outcome returned by the Machine. */
function MachineSettledResult(
  props: Readonly<{
    row: Extract<PluginInstallReviewRow, { kind: 'settled' }>;
  }>,
) {
  const { row } = props;
  return (
    <ItemGroup
      title={row.targetLabel.machine}
      description={row.targetLabel.server}
    >
      <Item
        testID={`settings.plugins.installOnMachines.outcome.${row.target.machineId}`}
        title={
          row.result.ok
            ? t('settingsPlugins.multiInstall.installed')
            : t('settingsPlugins.multiInstall.notInstalled')
        }
        subtitle={row.result.ok ? undefined : row.result.error}
        subtitleLines={0}
        mode="info"
        showChevron={false}
      />
    </ItemGroup>
  );
}

/** One Machine's own pending approval, read and decided by the canonical review controller. */
function MachineApprovalReview(
  props: Readonly<{
    row: Extract<PluginInstallReviewRow, { kind: 'approval' }>;
    register: (
      artifactId: string,
      controller: MachineReviewController | null,
    ) => void;
    /** Facts every reporting Machine shares, shown once above; a fact of this row's that differs stays here. */
    sharedFacts: readonly ConsentFact[];
  }>,
) {
  const { row, register, sharedFacts } = props;
  const review = useApprovalReview({
    artifactId: row.artifactId,
    serverId: row.serverId,
  });
  const ready = review.kind === 'ready' ? review : null;
  const reviewModalId = React.useRef<string | null>(null);
  React.useEffect(
    () => () => {
      if (reviewModalId.current) Modal.hide(reviewModalId.current);
    },
    [],
  );
  const openReview = () => {
    if (reviewModalId.current) return;
    reviewModalId.current = showApprovalReview({
      artifactId: row.artifactId,
      serverId: row.serverId,
      onDismissed: () => { reviewModalId.current = null; },
    });
  };
  const decideRef = React.useRef(ready?.decide);
  decideRef.current = ready?.decide;
  const settlement = ready ? describeMachineSettlement(ready) : null;
  const approvable = Boolean(
    ready?.approvable && ready.open && !ready.awaitsRequester,
  );
  const open = Boolean(ready?.open);
  // Still open here but not approvable by this person: the row says why, the same reason its own Approve would give.
  const withheldReason =
    ready?.open && !ready.awaitsRequester && !ready.approvable
      ? ready.approveWithheldReason
      : null;
  const superseded = settlement?.kind === 'superseded';
  const isReady = ready !== null;
  const pendingReview =
    ready && 'preview' in ready.request
      ? readPluginInstallApprovalPendingReview(ready.request.preview)
      : null;
  const factsSignature = JSON.stringify(
    pendingReview ? listPluginInstallConsentFacts(pendingReview) : [],
  );
  const facts = React.useMemo(
    (): readonly ConsentFact[] => JSON.parse(factsSignature),
    [factsSignature],
  );
  React.useEffect(() => {
    register(
      row.artifactId,
      isReady
        ? {
            target: row.target,
            approvable,
            open,
            superseded,
            decide: async (decision) => {
              await decideRef.current?.(decision);
            },
            facts,
          }
        : null,
    );
  }, [
    approvable,
    facts,
    isReady,
    open,
    register,
    row.artifactId,
    row.target,
    superseded,
  ]);
  React.useEffect(
    () => () => register(row.artifactId, null),
    [register, row.artifactId],
  );
  // Only what matches a shared fact exactly is left to the shared group; anything else of its own stays here.
  const ownFacts = facts.filter(
    (fact) => !sharedFacts.some((shared) => sameFact(shared, fact)),
  );
  return (
    <ItemGroup
      title={row.targetLabel.machine}
      description={row.targetLabel.server}
      testID={`settings.plugins.installOnMachines.machine.${row.target.machineId}`}
    >
      {review.kind === 'loading' ? (
        <Item
          title={t('settingsPlugins.multiInstall.checking')}
          loading
          mode="info"
          showChevron={false}
        />
      ) : review.kind !== 'ready' ? (
        <Item title={review.message} mode="info" showChevron={false} />
      ) : (
        <>
          {ownFacts.map((fact) => (
            <Item
              key={fact.key}
              title={fact.title}
              subtitle={fact.value}
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
          ))}
          {review.automaticChecks && readApprovalAutomaticChecksShown(review.automaticChecks) ? (
            <Item
              testID={`settings.plugins.installOnMachines.review.${row.target.machineId}`}
              title={t('approvals.review')}
              onPress={openReview}
            />
          ) : null}
          {withheldReason ? (
            <Item
              testID={`settings.plugins.installOnMachines.withheld.${row.target.machineId}`}
              title={withheldReason}
              subtitleLines={0}
              mode="info"
              showChevron={false}
            />
          ) : null}
          {approvable ? (
            <Item
              testID={`settings.plugins.installOnMachines.outcome.${row.target.machineId}`}
              title={t('settingsPlugins.multiInstall.ready')}
              mode="info"
              showChevron={false}
            />
          ) : null}
          {settlement && settlement.kind !== 'open' ? (
            <Item
              testID={`settings.plugins.installOnMachines.outcome.${row.target.machineId}`}
              title={settlement.title}
              subtitle={settlement.reason ?? undefined}
              subtitleLines={0}
              loading={settlement.kind === 'pending'}
              mode="info"
              showChevron={false}
            />
          ) : null}
        </>
      )}
    </ItemGroup>
  );
}

type ReadyReview = Extract<
  ReturnType<typeof useApprovalReview>,
  { kind: 'ready' }
>;
type MachineSettlement = Readonly<{
  kind: 'open' | 'pending' | 'installed' | 'declined' | 'superseded' | 'failed';
  title: string;
  reason?: string | null;
}>;

/** What became of one Machine's approval, in this flow's words; its typed failure stays its own. */
function describeMachineSettlement(review: ReadyReview): MachineSettlement {
  const update =
    'preview' in review.request &&
    readPluginInstallApprovalChange(review.request.preview) === 'update';
  const status = review.displayStatus;
  const failureCode = review.executionFailure?.code ?? null;
  if (status === 'open') return { kind: 'open', title: '' };
  if (status === 'approved' || status === 'executing')
    return {
      kind: 'pending',
      title: t('settingsPlugins.multiInstall.installing'),
    };
  if (status === 'executed')
    return {
      kind: 'installed',
      title: t('settingsPlugins.multiInstall.installed'),
    };
  if (status === 'rejected')
    return {
      kind: 'declined',
      title: t(
        update
          ? 'settingsPlugins.updateDeclined'
          : 'settingsPlugins.installDeclined',
      ),
    };
  if (status === 'canceled')
    return {
      kind: 'declined',
      title: t(
        update
          ? 'settingsPlugins.updateCanceled'
          : 'settingsPlugins.installCanceled',
      ),
    };
  if (
    status === 'expired' ||
    (failureCode && SUPERSEDED_CODES.has(failureCode))
  ) {
    return {
      kind: 'superseded',
      title: t('settingsPlugins.multiInstall.superseded'),
      reason: t('settingsPlugins.multiInstall.supersededReason'),
    };
  }
  return {
    kind: 'failed',
    title: t('settingsPlugins.multiInstall.notInstalled'),
    reason:
      review.executionFailure?.reason ?? formatApprovalStatusLabel(status),
  };
}
