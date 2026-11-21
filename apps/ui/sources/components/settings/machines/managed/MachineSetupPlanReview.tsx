import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { resolveHomeDisplayLabelForServerIdentity, resolveHomeDisplayNameForServerIdentity } from '@/components/settings/server/homeDisplayName';
import { t } from '@/text';
import { readMachineSetupAppIdentityV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { machineSetupSourceApplyOriginKeyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { z } from 'zod/mini';
import { MachineSetupPlanUnavailableTargetV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import type {
  MachineSetupPreparedApply,
  MachineSetupPreparedRemove,
  MachineSetupTargetReviewFacts,
  MachineSetupTargetSourcePresentations,
} from './machineSetupReview';
import {
  countMachineSetupTargetChanges,
  groupMachineSetupChanges,
  readMachineSetupTargetOpenedSource,
} from './machineSetupReviewChanges';
import { MachineSetupChangeGroupRow } from './MachineSetupChangeGroupRow';
import { describeManagedOperationDiagnostic } from './managedNativeFailurePresentation';
import { describeActionExecutionPrerequisite, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

export type MachineSetupPreparedReview = Extract<
  MachineSetupPreparedApply,
  { ok: true }
>;

/**
 * The one review of a prepared Machine setup (lab `setup/review`, Store `w:review`): which Machines it sets up,
 * which installed items to remove, what changes by kind, each app, whether it needs administrator access, its
 * downtime, and where it runs. Setup apply and the Store's Software review both present it; their own chrome owns
 * the primary action. A fact a Machine didn't report stays "Not known", never quietly safe.
 */
export function MachineSetupPlanReview(
  props: Readonly<{
    prepared: MachineSetupPreparedReview | Extract<MachineSetupPreparedRemove, { ok: true }>;
    nameOf: (machineId: string) => string;
    previouslyFailedMachineId?: string;
    /** Re-plans on another host Machine; absent when where it runs can't be changed here. */
    onChangeHost?: (machineId: string) => void;
    /**
     * Re-plans one Machine with these removals chosen; the fresh Plan's removal plans are what Apply then carries.
     * Absent where removal can't be chosen here: its offers then read as staying installed.
     */
    onChangeRemoval?: (machineId: string, removeItemKeys: string[]) => void;
    disabled?: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { prepared, nameOf } = props;
  const targets = 'targets' in prepared.input ? prepared.input.targets : [prepared.input];
  const factsOf = (machineId: string) =>
    prepared.facts.find((fact) => fact.machineId === machineId);
  const administrator = groupBy(
    targets.map((target) => target.machineId),
    (machineId) => {
      const review = factsOf(machineId)?.review;
      if (!review) return 'unreported';
      if (review.administratorUnavailable) return review.administratorUnavailable.reasonCode;
      return review.administratorRequired === true
        ? 'needed'
        : review.administratorRequired === false
          ? 'notNeeded'
          : 'unknown';
    },
  );
  const downtime = groupBy(
    targets.map((target) => target.machineId),
    (machineId) => factsOf(machineId)?.review?.downtime ?? 'unreported',
  );
  const single = targets.length === 1;
  const apps = targets.flatMap((target) =>
    'recipePlans' in target
      ? reviewApps(
          target,
          factsOf(target.machineId),
          prepared.sourcePresentations?.find((entry) =>
            entry.homeId === target.homeId && entry.machineId === target.machineId,
          )?.sources,
          nameOf(target.machineId),
        )
      : [],
  );
  const changes = groupMachineSetupChanges(targets, prepared.sourcePresentations);
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  // Items its new sources no longer have, by their recipe's own name; each stays unless removal is chosen.
  const removals = targets.flatMap((target) => {
    const facts = factsOf(target.machineId);
    const chosen = target.removeItemKeys ?? [];
    return (facts?.removalOffers ?? []).map((offer) => {
      const ref = offer.item.selection.ref;
      const title = facts?.recipeTitles?.find(
        (entry) =>
          entry.ref.pluginId === ref.pluginId &&
          entry.ref.recipeId === ref.recipeId &&
          entry.ref.revision === ref.revision,
      )?.title;
      return {
        key: `${target.machineId}.${offer.itemKey}`,
        machineId: target.machineId,
        itemKey: offer.itemKey,
        name: title === undefined ? ref.recipeId : localize(ref.pluginId, title),
        offer,
        chosen,
        selected: chosen.includes(offer.itemKey),
      };
    });
  });
  // One line per answer; several Machines name who it holds for. A Machine that reported nothing says so; one that
  // reported it doesn't know reads "Not known" too, never a safe answer.
  const answerLines = (
    groups: ReadonlyArray<readonly [string, readonly string[]]>,
    labelOf: (key: string) => string,
  ) =>
    groups
      .map(([key, machineIds]) => {
        const names = machineIds.map(nameOf).join(', ');
        if (key === 'unreported')
          return `${t('machinePresets.setup.review.unknown')} · ${t('machinePresets.setup.review.notReported', { machines: names })}`;
        const label =
          key === 'unknown' ? t('machinePresets.setup.review.unknown') : labelOf(key);
        return single || groups.length === 1 ? label : `${label} · ${names}`;
      })
      .join('\n');
  // The host that runs the steps: the combined review's, or the one Machine's own Plan review.
  const host =
    prepared.review ?? (single ? prepared.facts[0]?.review?.host : undefined);
  const hostId = host?.machineId ?? null;
  const [hostOpen, setHostOpen] = React.useState(false);
  const presence = (online: boolean) =>
    online ? t('status.online') : t('status.offline');
  const hostOnline = host?.machines.find(
    (machine) => machine.machineId === hostId,
  )?.online;
  // Labelled like Administrator and Downtime: the answer is the Machine (and whether it's online), or "Not known".
  const hostAnswer = hostId
    ? hostOnline === undefined
      ? nameOf(hostId)
      : `${nameOf(hostId)} · ${presence(hostOnline)}`
    : t('machinePresets.setup.review.unknown');
  const canChangeHost = Boolean(
    props.onChangeHost &&
    hostId &&
    host &&
    host.machines.some((machine) => machine.machineId !== hostId),
  );
  return (
    <>
      <ItemGroup title={t('machinePresets.setup.review.machines')}>
        {targets.map((target) => {
          // A new app deploys too, so the Machine isn't "already set up" while one waits. What each change is
          // reads under Changes, by kind.
          const count =
            countMachineSetupTargetChanges(
              target,
              prepared.sourcePresentations?.find((entry) =>
                entry.homeId === target.homeId && entry.machineId === target.machineId,
              )?.sources,
            ) +
            ('recipePlans' in target ? factsOf(target.machineId)?.review?.apps ?? [] : []).filter(
              (app) => app.kind === 'new',
            ).length;
          const lines = supportLines(factsOf(target.machineId));
          return (
            <Item
              key={`${target.homeId}:${target.machineId}`}
              testID={`${props.testID}.target.${target.machineId}`}
              title={nameOf(target.machineId)}
              {...(lines.length
                ? { subtitle: lines.join('\n'), subtitleLines: 0 }
                : {})}
              icon={
                <Icon
                  name="desktop"
                  size={ICON_SIZE.md}
                  color={theme.colors.text.secondary}
                />
              }
              detail={
                target.machineId === props.previouslyFailedMachineId ? t('approvals.status.failed')
                  : count === 0 ? t('machinePresets.setup.review.nothingToChange')
                    : t('machinePresets.setup.review.changes', { count })
              }
              mode="info"
              showChevron={false}
            />
          );
        })}
        {/* A Machine that was offline when it was planned is left out, by its Home and its own name: nothing waits
            for it, and the one Apply sets up only the Machines above. */}
        {(prepared.unavailableTargets ?? []).map((unavailable) => (
          <Item
            key={`unavailable:${unavailable.homeId}:${unavailable.machineId}`}
            testID={`${props.testID}.unavailable.${unavailable.homeId}.${unavailable.machineId}`}
            title={nameOf(unavailable.machineId)}
            subtitle={t('machinePresets.setup.review.leftOutOffline', {
              home: resolveHomeDisplayLabelForServerIdentity(unavailable.homeId),
            })}
            subtitleLines={0}
            icon={
              <Icon
                name="desktop"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            detail={t('machinePresets.setup.review.leftOut')}
            mode="info"
            showChevron={false}
          />
        ))}
      </ItemGroup>
      {removals.length ? (
        <ItemGroup
          title={t('machinePresets.setup.review.removeTitle')}
          description={t('machinePresets.setup.review.removeDescription')}
        >
          {removals.map((removal) => {
            const machine = nameOf(removal.machineId);
            const consequence =
              removal.offer.status === 'notEligible'
                ? t(`machinePresets.setup.review.removeNotEligible.${removal.offer.reason}`)
                : removal.selected
                  ? t('machinePresets.setup.review.removeChosen')
                  : t('machinePresets.setup.review.removeStays');
            const choosable =
              removal.offer.status === 'eligible' && props.onChangeRemoval;
            return (
              <Item
                key={removal.key}
                testID={`${props.testID}.remove.${removal.key}`}
                title={removal.name}
                subtitle={single ? consequence : `${machine} · ${consequence}`}
                subtitleLines={0}
                {...(choosable
                  ? {
                      rightElement: (
                        <Switch
                          testID={`${props.testID}.remove.${removal.key}.switch`}
                          value={removal.selected}
                          disabled={props.disabled}
                          accessibilityLabel={t('machinePresets.setup.review.removeLabel', { name: removal.name })}
                          onValueChange={(next) =>
                            props.onChangeRemoval?.(
                              removal.machineId,
                              next
                                ? [...removal.chosen, removal.itemKey]
                                : removal.chosen.filter((key) => key !== removal.itemKey),
                            )
                          }
                        />
                      ),
                    }
                  : { mode: 'info' as const, showChevron: false })}
              />
            );
          })}
        </ItemGroup>
      ) : null}
      {changes.length ? (
        <ItemGroup title={t('machinePresets.setup.review.changesTitle')}>
          {changes.map((group) => (
            <MachineSetupChangeGroupRow
              key={group.kind}
              group={group}
              testID={`${props.testID}.changes.${group.kind}`}
              nameOf={nameOf}
              targetCount={targets.length}
            />
          ))}
        </ItemGroup>
      ) : null}
      {apps.length ? (
        <ItemGroup title={t('machinePresets.setup.review.apps')}>
          {apps.map((app) => (
            <Item
              key={app.key}
              testID={`${props.testID}.app.${app.key}`}
              title={app.name}
              subtitle={single ? app.consequence : `${nameOf(app.machineId)} · ${app.consequence}`}
              subtitleLines={0}
              icon={
                <Icon
                  name="cube"
                  size={ICON_SIZE.md}
                  color={theme.colors.text.secondary}
                />
              }
              detail={app.state}
              mode="info"
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}
      {/* The facts about running it, as labelled rows in one sheet under the Machines (lab review card). */}
      <ItemGroup>
        <Item
          testID={`${props.testID}.administrator`}
          title={t('machinePresets.setup.review.administrator')}
          subtitle={answerLines(administrator, (key) =>
            describeActionExecutionPrerequisite(key)?.message ?? (key === 'needed'
              ? t('machinePresets.setup.review.adminNeeded')
              : t('machinePresets.setup.review.adminNotNeeded')),
          )}
          subtitleLines={0}
          mode="info"
          showChevron={false}
        />
        <Item
          testID={`${props.testID}.downtime`}
          title={t('machinePresets.setup.review.downtime')}
          subtitle={answerLines(downtime, (key) =>
            key === 'none'
              ? t('machinePresets.setup.review.downtimeNone')
              : t('machinePresets.setup.review.downtimePossible'),
          )}
          subtitleLines={0}
          mode="info"
          showChevron={false}
        />
        {canChangeHost && host && hostId ? (
          <DropdownMenu
            open={hostOpen}
            onOpenChange={setHostOpen}
            variant="selectable"
            search={false}
            selectedId={hostId}
            showCategoryTitles={false}
            connectToTrigger
            rowKind="item"
            itemTrigger={{
              title: t('machinePresets.setup.review.runsOn'),
              subtitle: hostAnswer,
              showSelectedSubtitle: false,
              detailFormatter: () => t('common.change'),
              itemProps: {
                testID: `${props.testID}.host`,
                disabled: props.disabled,
              },
            }}
            items={host.machines.map((machine) => ({
              id: machine.machineId,
              title: nameOf(machine.machineId),
              subtitle: presence(machine.online),
              disabled: !machine.online,
            }))}
            onSelect={(machineId) => {
              setHostOpen(false);
              if (machineId !== hostId) props.onChangeHost?.(machineId);
            }}
          />
        ) : (
          <Item
            testID={`${props.testID}.host`}
            title={t('machinePresets.setup.review.runsOn')}
            subtitle={hostAnswer}
            mode="info"
            showChevron={false}
          />
        )}
      </ItemGroup>
    </>
  );
}

/**
 * Every chosen Machine was offline, so nothing was planned: the typed failure says which ones, by Machine and
 * Home, instead of a generic "couldn't prepare". Null for any other failure.
 */
export function describeMachineSetupAllOffline(failure: ActionExecuteFailure, nameOf: (machineId: string) => string): string | null {
  if (failure.errorCode !== 'machine_offline') return null;
  const details: unknown = failure.details;
  const targets = z.array(MachineSetupPlanUnavailableTargetV1Schema).safeParse(
    details && typeof details === 'object' && 'targets' in details ? details.targets : undefined);
  if (!targets.success || targets.data.length === 0) return null;
  return t('machinePresets.setup.review.allOffline', {
    machines: targets.data.map((target) => {
      const home = resolveHomeDisplayNameForServerIdentity(target.homeId);
      return home ? `${nameOf(target.machineId)} (${home})` : nameOf(target.machineId);
    }).join(', '),
  });
}

/** Keep the target Plan owner's typed refusal visible on every setup review entry. */
export function describeMachineSetupPlanFailure(failure: ActionExecuteFailure, nameOf: (machineId: string) => string): string {
  const offline = describeMachineSetupAllOffline(failure, nameOf);
  if (offline) return offline;
  const technical = describeManagedOperationDiagnostic({ errorCode: failure.errorCode, error: failure.error });
  // A diagnostic that is only the refusal code says nothing to the person; the shared sentence does.
  const diagnostic = resolveActionExecutionFailureMessage(failure,
    technical === failure.errorCode ? t('common.requestFailed') : technical) ?? t('common.requestFailed');
  const details = failure.details;
  const target = details && typeof details === 'object' && 'target' in details ? details.target : undefined;
  return target && typeof target === 'object' && 'machineId' in target && typeof target.machineId === 'string'
    ? `${nameOf(target.machineId)} · ${diagnostic}` : diagnostic;
}

/** Every setup Apply surface presents the receiving Plan's prerequisite without inspecting Machine policy. */
export function describeMachineSetupReviewUnavailable(
  prepared: Pick<MachineSetupPreparedReview, 'facts'> | null | undefined,
  nameOf: (machineId: string) => string,
): string | undefined {
  const reasons = prepared?.facts.flatMap(fact => {
    const unavailable = fact.review?.administratorUnavailable;
    const prerequisite = unavailable && describeActionExecutionPrerequisite(unavailable.reasonCode);
    return prerequisite ? [`${nameOf(fact.machineId)} · ${prerequisite.message}`] : [];
  });
  return reasons?.length ? reasons.join('\n') : undefined;
}

/**
 * The review's closing row, shared by every setup review (Store Install on…, Set up from a preset): the shared
 * card footer (`ModalCardFooterActions`) with the setup's own facts — who approves, or why the primary waits.
 */
export function MachineSetupReviewFooter(
  props: Readonly<{
    prepared?: Pick<MachineSetupPreparedReview, 'facts'> | null;
    nameOf?: (machineId: string) => string;
    onCancel: () => void;
    cancelTestID: string;
    /** The secondary control's name; Cancel by default (a review one step in says Back). */
    cancelLabel?: string;
    /** The footer's quiet note; the approval note by default, none when `null` (nothing it could reassure about). */
    note?: string | null;
    /** Absent while the run waits on its approval elsewhere. */
    primary?: Readonly<{
      label: string;
      onPress: () => void;
      loading?: boolean;
      disabled?: boolean;
      /** Why it is disabled: read in the footer's note slot, and by assistive technology. */
      disabledReason?: string;
      testID: string;
    }>;
  }>,
) {
  const prerequisite = props.prepared && props.nameOf ? describeMachineSetupReviewUnavailable(props.prepared, props.nameOf) : undefined;
  const reason = prerequisite ?? (props.primary?.disabled ? props.primary.disabledReason : undefined);
  // The setup's Administrator row already explains a prerequisite; it stays the button's hint, not a second note.
  const note = prerequisite !== undefined || reason === undefined && props.note === null
    ? null : reason ?? props.note ?? t('capabilities.store.softwarePage.approvalNote');
  return (
    <ModalCardFooterActions
      cancel={{ onPress: props.onCancel, testID: props.cancelTestID, ...(props.cancelLabel ? { title: props.cancelLabel } : {}) }}
      note={note}
    >
      {props.primary ? (
        <RoundButton
          testID={props.primary.testID}
          size="normal"
          title={props.primary.label}
          loading={props.primary.loading}
          disabled={props.primary.disabled || prerequisite !== undefined}
          {...(reason === undefined ? {} : { accessibilityHint: reason })}
          onPress={props.primary.onPress}
        />
      ) : null}
    </ModalCardFooterActions>
  );
}

/** Items a Machine can't take or couldn't check, counted from its Plan's per-item support. */
function supportLines(
  facts: MachineSetupTargetReviewFacts | undefined,
): string[] {
  const support = facts?.support ?? [];
  const unsupported = support.filter(
    (item) => item.status === 'unsupported',
  ).length;
  const unchecked = support.filter(
    (item) => item.status === 'unavailable' || item.status === 'unverifiable',
  ).length;
  return [
    ...(unsupported
      ? [t('machinePresets.setup.review.unsupported', { count: unsupported })]
      : []),
    ...(unchecked
      ? [t('machinePresets.setup.review.unchecked', { count: unchecked })]
      : []),
  ];
}

type ReviewTarget = MachineSetupPreparedReview['input']['targets'][number];

/**
 * Each app the Plan reported, by its own name, with what this setup does to it. Only a new app deploys, once; one
 * already deployed stays as it is (a changed pin doesn't redeploy it), and an unread outcome is "Not known".
 */
function reviewApps(
  target: ReviewTarget,
  facts: MachineSetupTargetReviewFacts | undefined,
  sourcePresentations: MachineSetupTargetSourcePresentations['sources'] | undefined,
  machine: string,
) {
  // A Machine that reported nothing about apps lists only locally opened exact sources as not known.
  const reported =
    facts?.review?.apps ??
    target.sources.flatMap((_, sourceIndex) =>
      (readMachineSetupTargetOpenedSource(target, sourceIndex, sourcePresentations)?.setup.items ?? []).flatMap((item, itemIndex) =>
        item.kind === 'app'
          ? [{ sourceIndex, itemIndex, kind: 'unreported' as const }]
          : [],
      ),
    ) ?? [];
  return reported.flatMap((app) => {
    const source = readMachineSetupTargetOpenedSource(target, app.sourceIndex, sourcePresentations);
    const actionSource = target.sources[app.sourceIndex];
    const item = source?.setup.items?.[app.itemIndex];
    if (!source || !actionSource || item?.kind !== 'app') return [];
    // Only a catalog app has a pin; its identity ignores the pin, so an accepted run of it with another pin is the change.
    const pinChanged = () => {
      if (item.definition.definition.from !== 'catalogApp') return false;
      const identity = readMachineSetupAppIdentityV1(item);
      const accepted = (
        facts?.sourceFacts?.[machineSetupSourceApplyOriginKeyV1(actionSource)]
          ?.acceptedAppRuns ?? []
      ).filter(
        (run) =>
          readMachineSetupAppIdentityV1({ kind: 'app', definition: run.intent }) === identity,
      );
      return (
        accepted.length > 0 &&
        !accepted.some((run) =>
          sameStrictJsonValue(run.intent.definition, item.definition.definition),
        )
      );
    };
    const [state, consequence] =
      app.kind === 'new'
        ? [t('machinePresets.setup.review.appNew'), t('machinePresets.setup.review.appNewOnce')]
        : app.kind === 'completed'
          ? [
              t('machinePresets.setup.review.appDeployed'),
              pinChanged()
                ? t('machinePresets.setup.review.appPinChanged')
                : t('machinePresets.setup.review.appStays'),
            ]
          : app.kind === 'not_completed'
            ? [t('machinePresets.setup.review.appStillDeploying'), t('machinePresets.setup.review.appNotStarted')]
            : app.kind === 'failed'
              ? [t('machinePresets.setup.review.appFailed'), t('machinePresets.setup.review.appNotRetried')]
              : app.kind === 'unknown'
                ? [t('machinePresets.setup.review.unknown'), t('machinePresets.setup.review.appUnknown', { machine })]
                : [t('machinePresets.setup.review.unknown'), t('machinePresets.setup.review.notReported', { machines: machine })];
    return [
      {
        key: `${target.machineId}.${app.sourceIndex}.${app.itemIndex}`,
        machineId: target.machineId,
        name: item.definition.name,
        state,
        consequence,
      },
    ];
  });
}

function groupBy<K extends string>(
  machineIds: readonly string[],
  keyOf: (machineId: string) => K,
): Array<readonly [K, string[]]> {
  const groups = new Map<K, string[]>();
  for (const machineId of machineIds) {
    const key = keyOf(machineId);
    groups.set(key, [...(groups.get(key) ?? []), machineId]);
  }
  return [...groups.entries()];
}
