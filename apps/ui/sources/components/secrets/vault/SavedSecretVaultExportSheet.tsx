import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  parseSavedSecretCatalogReferenceV1,
  type SavedSecretCatalogEntryV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { SavedSecretSourceOption } from '@/sync/api/account/savedSecretCatalogPresentation';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';

import type { SavedSecretCatalogProjection } from '../useSavedSecretCatalog';
import { useSavedSecretExportReferences } from '../useSavedSecretExportReferences';
import {
  SavedSecretVaultFields,
  savedSecretVaultRepairCopy,
  useSavedSecretVaultChoice,
} from './SavedSecretVaultFields';

type ExportResult = Extract<
  Awaited<ReturnType<SavedSecretCatalogProjection['exportResourcesToVault']>>,
  { kind: 'succeeded' }
>['value']['results'][number];
type Phase = Readonly<
  | { kind: 'editing'; notice?: string }
  | { kind: 'moving' }
  | { kind: 'approval' }
  | { kind: 'settled'; vault: string; results: readonly ExportResult[] }
>;

/** A secret whose value Happier keeps, owned by and private to this person: the ones that can move. */
export function isSavedSecretVaultExportCandidate(
  entry: SavedSecretCatalogEntryV1,
): boolean {
  const audience = entry.audience;
  const shared = audience
    ? audience.accounts.length +
        audience.teams.length +
        audience.groups.length >
      0
    : false;
  return (
    entry.relationship === 'owner' &&
    entry.storage?.kind === 'value' &&
    !shared &&
    entry.revision !== null &&
    entry.materialStatus === 'ready' &&
    parseSavedSecretCatalogReferenceV1(entry.ref)?.kind === 'shared_resource'
  );
}

type ExportSheetProps = Readonly<{
  scope: ServerAccountScope;
  source: SavedSecretSourceOption;
  candidates: readonly SavedSecretCatalogEntryV1[];
  /** The row it was opened from starts chosen; the others are one tap away. */
  initialRef: string;
  exportResources: SavedSecretCatalogProjection['exportResourcesToVault'];
  requestApproval: (registration: ActionApprovalRegistration) => void;
  onSettled: () => void;
}>;

/** Settings → Secrets → a secret's "Move to <vault source>": one sheet for one secret or several. */
export function presentSavedSecretVaultExportSheet(
  props: ExportSheetProps,
): void {
  Modal.show({
    component: SavedSecretVaultExportSheet,
    props,
    chrome: {
      ...createAnchoredSheetChrome({
        title: t('secretsSettings.exportTitle', {
          provider: props.source.title,
        }),
        testID: 'saved-secret-export',
      }),
      bodyScroll: 'auto',
    },
    closeOnBackdrop: false,
  });
}

/**
 * Where the values go (account and vault), which secrets move, then one confirmation of exactly that.
 * Each secret settles on its own: one that fails stays unchanged in Happier, and nothing is replayed.
 */
function SavedSecretVaultExportSheet(
  props: CustomModalInjectedProps & ExportSheetProps,
) {
  const provider = props.source.title;
  const choice = useSavedSecretVaultChoice({
    scope: props.scope,
    source: props.source,
    onApprovalPending: props.requestApproval,
  });
  const [chosen, setChosen] = React.useState<ReadonlySet<string>>(
    () => new Set([props.initialRef]),
  );
  const [phase, setPhase] = React.useState<Phase>({ kind: 'editing' });
  const references = useSavedSecretExportReferences(props.scope, true);
  const lifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => lifetime.current?.abort(), []);
  // Which connected services read each secret: they keep their reference, so they keep working.
  const usedBy = React.useMemo(() => {
    const registry = getConnectedServiceRegistrySnapshot(props.scope);
    const names = new Map<string, Set<string>>();
    for (const reference of references.references) {
      const set = names.get(reference.secretId) ?? new Set<string>();
      set.add(
        resolveQualifiedConnectedServiceRegistryDisplayName(
          registry,
          reference.service,
          t,
        ),
      );
      names.set(reference.secretId, set);
    }
    return names;
  }, [props.scope, references.references]);
  const selected = props.candidates.filter((entry) => chosen.has(entry.ref));
  const busy = phase.kind === 'moving' || phase.kind === 'approval';
  const target = choice.target;

  const move = React.useCallback(async () => {
    if (!target || selected.length === 0 || !choice.vault) return;
    const vaultName = choice.vault.name;
    lifetime.current?.abort();
    const controller = new AbortController();
    lifetime.current = controller;
    setPhase({ kind: 'moving' });
    try {
      const outcome = await props.exportResources(
        {
          target,
          secrets: selected.map((entry) => ({
            secretId: resourceIdOf(entry),
            expectedUpdatedAt: entry.revision ?? 0,
          })),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      props.onSettled();
      if (outcome.kind === 'succeeded')
        setPhase({
          kind: 'settled',
          vault: vaultName,
          results: outcome.value.results,
        });
      else
        setPhase({
          kind: 'editing',
          notice:
            outcome.failure.kind === 'outcome_unknown'
              ? t('secretsSettings.exportUnknown', { provider })
              : t('secretsSettings.exportFailed'),
        });
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (isTeamActionApprovalPendingError(cause)) {
        props.requestApproval(cause.registration);
        setPhase({ kind: 'approval' });
        return;
      }
      setPhase({ kind: 'editing', notice: t('secretsSettings.exportFailed') });
    }
  }, [choice.vault, props, provider, selected, target]);

  const settled = phase.kind === 'settled' ? phase : null;
  const failedRefs = settled
    ? new Set(
        settled.results
          .filter((result) => result.status === 'failed')
          .map((result) => result.secretRef),
      )
    : null;
  const footer = (
    <RoundButtonSizeScope size="normal" presentation="uniform">
      <View style={styles.actions}>
        {settled ? (
          <>
            {failedRefs && failedRefs.size > 0 ? (
              <RoundButton
                testID="saved-secret-export:retry"
                display="secondary"
                title={t('secretsSettings.exportRetryFailed')}
                onPress={() => {
                  const remaining = props.candidates
                    .filter((entry) => failedRefs.has(entry.ref))
                    .map((entry) => entry.ref);
                  setChosen(new Set(remaining));
                  setPhase({ kind: 'editing' });
                }}
              />
            ) : null}
            <RoundButton
              testID="saved-secret-export:done"
              title={t('common.done')}
              onPress={props.onClose}
            />
          </>
        ) : (
          <>
            <RoundButton
              testID="saved-secret-export:cancel"
              display="secondary"
              title={t('common.cancel')}
              onPress={() => {
                lifetime.current?.abort();
                props.onClose();
              }}
            />
            <RoundButton
              testID="saved-secret-export:confirm"
              title={t('secretsSettings.exportConfirm', {
                count: selected.length,
              })}
              loading={busy}
              disabled={busy || !target || selected.length === 0}
              onPress={() => {
                void move();
              }}
            />
          </>
        )}
      </View>
    </RoundButtonSizeScope>
  );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      subtitle: settled
        ? undefined
        : t('secretsSettings.exportPurpose', { provider }),
      footer,
    });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  if (settled) {
    const nameOf = (ref: string) =>
      props.candidates.find((entry) => entry.ref === ref)?.name ??
      t('secrets.catalog.unavailableName');
    return (
      <ListPresentationProvider value="page" pageInsets="contained">
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.frame}
          testID="saved-secret-export:result"
        >
          <SavedSecretVaultExportResults
            results={settled.results}
            vault={settled.vault}
            provider={provider}
            nameOf={nameOf}
          />
          {setChrome ? null : <View style={styles.inlineFooter}>{footer}</View>}
        </ScrollView>
      </ListPresentationProvider>
    );
  }

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.frame}
        keyboardShouldPersistTaps="handled"
        testID="saved-secret-export:form"
      >
        <View style={styles.fields}>
          <SavedSecretVaultFields
            choice={choice}
            provider={provider}
            disabled={busy}
            testID="saved-secret-export-vault"
          />
        </View>
        <ItemGroup title={t('secretsSettings.exportSecretsTitle')}>
          {props.candidates.map((entry) => {
            const checked = chosen.has(entry.ref);
            const services = [...(usedBy.get(resourceIdOf(entry)) ?? [])];
            return (
              <Item
                key={entry.ref}
                testID={`saved-secret-export:secret:${entry.ref}`}
                title={entry.name ?? t('secrets.catalog.unavailableName')}
                subtitle={
                  services.length
                    ? t('secretsSettings.exportUsedBy', {
                        names: services.join(', '),
                      })
                    : undefined
                }
                icon={
                  <SelectionCheckGlyph
                    state={checked ? 'checked' : 'unchecked'}
                  />
                }
                accessibilityRole="checkbox"
                accessibilityChecked={checked}
                showChevron={false}
                disabled={busy}
                onPress={() =>
                  setChosen((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.ref)) next.delete(entry.ref);
                    else next.add(entry.ref);
                    return next;
                  })
                }
              />
            );
          })}
        </ItemGroup>
        {phase.kind === 'approval' ? (
          <SectionContentRow showDivider={false}>
            <SurfaceStateCard
              testID="saved-secret-export:approval"
              kind="warning"
              size="line"
              title={t('secrets.catalog.approvalPending')}
            />
          </SectionContentRow>
        ) : phase.kind === 'editing' && phase.notice ? (
          <SectionContentRow showDivider={false}>
            <SurfaceStateCard
              testID="saved-secret-export:notice"
              kind="error"
              size="line"
              title={phase.notice}
            />
          </SectionContentRow>
        ) : null}
        {setChrome ? null : <View style={styles.inlineFooter}>{footer}</View>}
      </ScrollView>
    </ListPresentationProvider>
  );
}


/** Each secret's own settlement: moved to the vault, or why it stayed unchanged in Happier. */
export function SavedSecretVaultExportResults(props: Readonly<{
  results: readonly ExportResult[];
  vault: string;
  provider: string;
  nameOf: (secretRef: string) => string;
}>) {
  const { theme } = useUnistyles();
  const { provider } = props;
  const settled = props;
  const nameOf = props.nameOf;
  const moved = settled.results.filter(
    (result) => result.status === 'exported',
  ).length;
  return (
    <ItemGroup
            title={t('secretsSettings.exportResultSummary', {
              moved,
              total: settled.results.length,
            })}
          >
            {settled.results.map((result, index) => (
              <Item
                key={result.secretRef}
                testID={`saved-secret-export:result:${index}`}
                title={nameOf(result.secretRef)}
                subtitle={
                  result.status === 'exported'
                    ? t('secretsSettings.exportMoved', { vault: settled.vault })
                    : result.repair
                      ? savedSecretVaultRepairCopy(provider, result.repair)
                      : t('secretsSettings.exportFailedItem')
                }
                subtitleLines={0}
                icon={
                  <Icon
                    name={
                      result.status === 'exported'
                        ? 'check-circle'
                        : 'warning-circle'
                    }
                    size={ICON_SIZE.md}
                    color={
                      result.status === 'failed'
                        ? theme.colors.state.warning.foreground
                        : theme.colors.text.secondary
                    }
                  />
                }
                mode="info"
                showChevron={false}
                showDivider={index < settled.results.length - 1}
              />
            ))}
          </ItemGroup>
  );
}

function resourceIdOf(entry: SavedSecretCatalogEntryV1): string {
  const parsed = parseSavedSecretCatalogReferenceV1(entry.ref);
  return parsed?.kind === 'shared_resource' ? parsed.id : entry.ref;
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flexShrink: 1, minHeight: 0 },
  frame: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s16,
    gap: theme.space.s4,
  },
  fields: { gap: theme.space.s12, paddingBottom: theme.space.s12 },
  inlineFooter: { paddingTop: theme.space.s12 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
