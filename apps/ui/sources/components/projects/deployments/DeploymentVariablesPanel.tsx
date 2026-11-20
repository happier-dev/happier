import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
} from '@happier-dev/plugin-ui';
import { DeploymentVariableFactOptionsV1, type DeploymentVariableFactV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { DeploymentEnvironmentReadDetailV1, EnvironmentSecretBindingProjectionV1 } from '@happier-dev/deployments';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { INLINE_ADD_OPEN, useInlineAddDraftField } from './inlineAddDraft';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  readDeploymentActionError,
  readDeploymentActionResult,
  type DeploymentActionOutcome,
} from './deploymentActionOutcome';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import type { useEnvironmentSecretBindingsDraft } from './useEnvironmentSecretBindingsDraft';
import { useEnvironmentSavedSecretBindings, type EnvironmentSavedSecretBindingResult } from './useEnvironmentSavedSecretBindings';
import type { EnvironmentBulkSourceLabel } from './useEnvironmentSecretBindingsEditor';
import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import { SharedSavedSecretValueItem } from '@/components/secrets/SharedSavedSecretValueItem';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { DeploymentSecretControlTarget } from './DeploymentWithdrawnSecretControl';
import { DeploymentSecretBindingsNotice } from './DeploymentSecretBindingsNotice';
import { DeploymentEnvironmentDomainSelect } from './DeploymentEnvironmentDomainSelect';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { privateServiceExportReachLabel } from './DeploymentPrivateServiceExports';
import { isPrivateServiceExport } from './privateServiceExport';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';
import { useDeploymentProviderVariables } from './useDeploymentProviderVariables';
import type { DeploymentTargetVariableMetadataV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import type { DeploymentBindingsSetResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
const providerKeyOf = (fact: DeploymentTargetVariableMetadataV1) => fact.key;
type ProviderSaveResult = NonNullable<Extract<DeploymentBindingsSetResultV1, { ok: true }>['providerVariables']>;

type VariableBinding = Extract<EnvironmentSecretBindingProjectionV1['binding'], { purpose: 'variable' }>;
type Phase = 'build' | 'runtime' | 'both';
type VariableRow = Readonly<{
  key: string;
  name: string;
  phase: Phase;
  binding: VariableBinding;
  /** The binding identities this row stands for: one, or the build+runtime pair a "Both" row reads as. */
  identities: readonly string[];
}>;
type BindingsDraft = ReturnType<typeof useEnvironmentSecretBindingsDraft>;
type SavedSecretBindings = ReturnType<typeof useEnvironmentSavedSecretBindings>;
type SecretSources = EnvironmentSavedSecretBindingResult['sources'];
type PanelMode = 'table' | 'bulk';
type Adding = 'plain' | 'secret' | 'saved' | 'reference' | 'fact';
type SecretSource = Extract<VariableBinding['source'], { kind: 'secret' }>;

const PHASES: readonly Phase[] = ['build', 'runtime', 'both'];
/** A pasted secret's value never shows again: a fixed run of dots stands for it. */
const MASK = '••••••••••••••••••••••••';
const TABLE_MIN_WIDTH_PX = 520;
const keyOf = (row: VariableRow) => row.key;
/** A service another variable can point at: one declared service export of an Environment the page can name. */
export type VariableReferenceTarget = Readonly<{ environmentId: string; export: string; service: string;
  /** Where the export is published: Happier network or the joined network's name (DEPLOY-UI-LOGIC-B 10:25Z contract). */
  network?: string }>;
/** The Environments a reference can point into, by id and name, the current one first (the page's held list). */
export type VariableReferenceEnvironments = ReadonlyMap<string, Readonly<{ name: string; machineIds: readonly string[] }>>;
const NO_REFERENCE_TARGETS: readonly VariableReferenceTarget[] = Object.freeze([]);
const NO_REFERENCE_ENVIRONMENTS: VariableReferenceEnvironments = new Map();
/** Without the page's read, another Environment's record is not read at all. */
const HIDDEN_REFERENCE_READ = Object.freeze({ mounted: false, visible: false, focused: false });
type SecretRevisions = DeploymentEnvironmentReadDetailV1['secretRevisions'];
/** Per variable (name, phase): the newest saved revision the running release does not have yet. */
type RotatedSecrets = ReadonlyMap<string, number>;
const NO_ROTATED: RotatedSecrets = new Map();
const rotationKey = (name: string, phase: 'build' | 'runtime') => JSON.stringify([name, phase]);
const noop = () => {};

/**
 * Environment → Variables (lab r3 `variables/rows`, round 9 `variables/phase`): a table of names with where each
 * is used and where its value comes from. Rows read metadata only. They come from Plan 42's binding
 * projection (K1) through the page's draft owner. Only the shared Reveal leaf reads a value after confirmation.
 * Identities stay stable across echoes; every change is local
 * until Save through the draft's owning Environment Action (a "Both" change is the build+runtime pair at once).
 */
export const DeploymentVariablesPanel = React.memo(
  function DeploymentVariablesPanel(
    props: Readonly<{
      draft: BindingsDraft;
      title?: string;
      description?: string;
      phone: boolean;
      environmentName: (environmentId: string) => string | null;
      /** The Machine the release starts on, which alone opens the sealed secrets. */
      sealedOn: string | null;
      review: DeploymentReviewHandle;
      /** The Environment the draft edits: a new secret binds only into this one. */
      environmentId: string;
      projectSourceId?: string;
      providerTargetLinkId?: string | null;
      providerVariablesActive?: boolean;
      /** The Home/Account a new secret is saved under (Settings → Secrets); null while it is not current. */
      scope: AccountSettingsScope | null;
      controlTarget?: DeploymentSecretControlTarget;
      /** The same Home/Account's lifetime: "Use a saved secret…" picks only while it is current. */
      lifetime: ServerAccountScopeLifetime | null;
      /**
       * The Environment controller's running-vs-saved secret facts per runtime member (T2-DOMAIN-PREVIEW
       * `secretRevisions` on the Environment detail); absent before the page has them.
       */
      secretRevisions?: SecretRevisions | null;
      /** The page's Deploy, offered once the new revisions are saved; absent where this viewer cannot deploy. */
      onDeploy?: (() => void) | null;
      /** Declared service exports "Point at another service" offers (this Environment's and its Project's). */
      referenceTargets?: readonly VariableReferenceTarget[];
      /** Other Environments of this Project whose shared services a reference may point at (their exact read). */
      referenceEnvironments?: VariableReferenceEnvironments;
      domainRead?: Pick<React.ComponentProps<typeof DeploymentEnvironmentDomainSelect>, 'controller' | 'demand'>;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { draft } = props;
    const editor = draft.editor;
    const provider = useDeploymentProviderVariables({ lifetime: props.lifetime, active: props.providerVariablesActive, projectSourceId: props.projectSourceId,
      environmentId: props.environmentId, targetLinkId: props.providerTargetLinkId });
    const providerByKey = React.useMemo(() => new Map(provider.value?.variables.map(row => [row.key, row]) ?? []), [provider.value]);
    const [providerSaveState, setProviderSave] = React.useState<Readonly<{ lifetime: typeof props.lifetime; environmentId: string; result: ProviderSaveResult }> | null>(null);
    const providerSave = providerSaveState?.lifetime === props.lifetime && providerSaveState.environmentId === props.environmentId
      ? providerSaveState.result : null;
    // A Saved Secret row names its secret from the Account's one catalog (no material is read).
    const catalog = useSavedSecretCatalogEntries({ scope: props.scope });
    const secretName = React.useCallback(
      (ref: string) => catalog.find((entry) => entry.ref === ref)?.name ?? null,
      [catalog],
    );
    const rows = React.useMemo(() => variableRows(editor.rows), [editor.rows]);
    const providerOnly = React.useMemo(() => {
      const authored = new Set(rows.map(row => row.name));
      return provider.value?.variables.filter(fact => !authored.has(fact.key)) ?? [];
    }, [provider.value, rows]);
    const providerOnlyModel = useHappierCollection<DeploymentTargetVariableMetadataV1>({
      items: providerOnly, keyOf: providerKeyOf, openKey: null, onOpenChange: noop,
    });
    const rotated = React.useMemo(() => rotatedSecrets(props.secretRevisions ?? null), [props.secretRevisions]);
    // Rows still bound to an older revision than the newest one saved: "Use the new revision" re-binds them here.
    const stale = React.useMemo(() => rows.filter(row => row.binding.source.kind === 'secret'
      && (rowRotation(row, rotated) ?? 0) > row.binding.source.resourceRevision), [rotated, rows]);
    const [disclosedKey, setDisclosedKey] = React.useState<string | null>(null);
    const disclosedRow = rows.find(row => JSON.stringify([props.environmentId, row.key]) === disclosedKey);
    const disclosedRef = disclosedRow?.binding.source.kind === 'secret' ? disclosedRow.binding.source.ref : null;
    const disclosedEntry = catalog.find(entry => entry.ref === disclosedRef);
    const manageSecret = React.useCallback((ref: string) => {
      router.push({ pathname: SETTINGS_ROUTES.secrets, params: { secret: ref } });
    }, [router]);
    const editable = draft.canEdit && !draft.saving;
    // The open Add form and what was typed in it survive a width change that recomposes the page (PAGE-ACCEPT-176 R8-D3).
    const draftKey = `variables:${props.scope?.serverId ?? props.controlTarget?.serverId ?? ''}:${props.environmentId}`;
    const [adding, setAdding] = useInlineAddDraftField<Adding | null>(draftKey, INLINE_ADD_OPEN, null);
    const [fact, setFact] = React.useState<DeploymentVariableFactV1>('primaryUrl');
    const [factOpen, setFactOpen] = React.useState(false);
    const [factDomainId, setFactDomainId] = React.useState<string | null>(null);
    // "Use a saved secret…" (lab d2 `pick`): the shared reference-only picker, then a name for it here.
    const [picked, setPicked] = React.useState<SecretSource | null>(null);
    const pickSaved = React.useCallback(async () => {
      const lifetime = props.lifetime;
      if (!lifetime) return;
      const controller = new AbortController();
      const selection = await presentSavedSecretReferencePicker({
        accountLifetime: lifetime, signal: controller.signal, isCurrent: () => lifetime.isCurrent(),
      });
      if (!selection) return;
      setPicked({ kind: 'secret', ref: selection.ref, resourceRevision: selection.resourceRevision });
      setAdding('saved');
    }, [props.lifetime]);
    const [mode, setMode] = React.useState<PanelMode>(() => editor.bulkInput === null ? 'table' : 'bulk');
    // Saved Secrets own creation; the editor only takes their references into this draft, saved below.
    const saved = useEnvironmentSavedSecretBindings({
      scope: props.scope,
      scopeKey: props.environmentId,
      editor,
      readOnly: !editable,
    });
    const [outcome, setOutcome] =
      React.useState<DeploymentActionOutcome | null>(null);
    const model = useHappierCollection<VariableRow>({
      items: rows,
      keyOf,
      openKey: null,
      onOpenChange: noop,
    });

    const setPhase = React.useCallback(
      (row: VariableRow, phase: Phase) => {
        if (phase === row.phase) return;
        const phases =
          phase === 'both' ? (['build', 'runtime'] as const) : [phase];
        editor.putMany(
          phases.map((p) => ({ ...row.binding, phase: p })),
          row.identities,
        );
      },
      [editor],
    );
    const remove = React.useCallback(
      (row: VariableRow) => {
        editor.putMany([], row.identities);
      },
      [editor],
    );

    const anatomy = React.useMemo<CollectionAnatomy<VariableRow>>(() => {
      const phaseControl = (row: VariableRow) => (
        <PhaseMenu
          row={row}
          disabled={!editable}
          onSelect={(phase) => setPhase(row, phase)}
        />
      );
      // The resting list (a phone, a narrow pane) has no phase column, so its ⋯ holds "Used at" too.
      const rowMenu = (withPhase: boolean) => (row: VariableRow) => {
        const source = row.binding.source;
        const entry = source.kind === 'secret' ? catalog.find(entry => entry.ref === source.ref) : undefined;
        return (
        <VariableRowMenu
          row={row}
          disabled={!editable}
          withPhase={withPhase}
          onPhase={(phase) => setPhase(row, phase)}
          onRemove={() => remove(row)}
          onReveal={entry && props.scope
            ? () => setDisclosedKey(JSON.stringify([props.environmentId, row.key])) : undefined}
          onRotate={source.kind === 'secret' && entry?.capabilities.rotate
            ? () => manageSecret(source.ref) : undefined}
        />
        );
      };
      const source = (row: VariableRow) => (
        <ValueSource
          binding={row.binding}
          environmentName={props.environmentName}
          secretName={secretName}
          rotatedTestID={rowRotation(row, rotated) !== null ? `project-deployments.environment.variable.${row.name}.rotated` : undefined}
        />
      );
      return {
        glyph: (row) => (
          <Icon
            name={sourceIcon(row.binding.source.kind)}
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
        title: (row) => row.name,
        // The list reads one row as the lab's `rowsp`: the name, then where it is used and its value.
        byline: (row: VariableRow) => (
              <View>
                <Text
                  variant="meta"
                  numberOfLines={2}
                  style={{ color: theme.colors.text.secondary }}
                >
                  {`${phaseLabel(row.phase)} · ${sourceTitle(row.binding, props.environmentName, secretName)}`}
                  {rowRotation(row, rotated) !== null ? <>{' · '}<RotatedWord
                    testID={`project-deployments.environment.variable.${row.name}.rotated`} /></> : null}
                </Text>
                {providerByKey.has(row.name) ? <ProviderVariableStatus fact={providerByKey.get(row.name)!}
                  choice={draft.providerChoices.get(row.name)} editable={editable}
                  onChoose={choice => draft.chooseProviderVariable(row.name, choice)} /> : null}
              </View>
              ),
        action: rowMenu(true),
        fields: [
                {
                  key: 'usedAt',
                  title: t('projects.deployments.columnUsedAt'),
                  render: phaseControl,
                  // The phase is the row's one decision: it stays after the name; Value from gives way first.
                  minWidth: 104,
                  priority: 5,
                  leading: true,
                  control: true,
                },
                {
                  key: 'valueFrom',
                  title: t('projects.deployments.columnValueFrom'),
                  render: source,
                  // Where a value comes from is the row's longest fact (a secret's name and revision): it gets the room.
                  minWidth: 240,
                  priority: 4,
                },
                ...(props.providerTargetLinkId ? [{
                  key: 'provider', title: t('projects.deployments.providerVariablesColumn'),
                  render: (row: VariableRow) => providerByKey.has(row.name) ? <ProviderVariableStatus fact={providerByKey.get(row.name)!}
                    choice={draft.providerChoices.get(row.name)} editable={editable}
                    onChoose={choice => draft.chooseProviderVariable(row.name, choice)} /> : null,
                  minWidth: 180, priority: 6, control: true,
                }] : []),
                {
                  key: 'menu',
                  title: '',
                  render: rowMenu(false),
                  minWidth: 32,
                  priority: 6,
                  align: 'end' as const,
                  control: true,
                },
              ],
        accessibilityLabel: (row) =>
          `${row.name}, ${phaseLabel(row.phase)}, ${sourceTitle(row.binding, props.environmentName, secretName)}`,
        testID: (row) => `project-deployments.environment.variable.${row.name}`,
        columnTitles: { title: t('projects.deployments.columnName') },
        // Names are short identifiers: the title column keeps what a name needs, not a sentence's room.
        titleMinWidth: 160,
      };
    }, [
      editable,
      providerByKey,
      draft.providerChoices,
      draft.chooseProviderVariable,
      props.providerTargetLinkId,
      props.environmentName,
      secretName,
      remove,
      setPhase,
      catalog,
      props.scope,
      props.environmentId,
      manageSecret,
      rotated,
      theme.colors.text.secondary,
    ]);

    const providerOnlyAnatomy = React.useMemo<CollectionAnatomy<DeploymentTargetVariableMetadataV1>>(() => ({
      glyph: () => null,
      loadingGlyph: false,
      title: fact => fact.key,
      byline: fact => <ProviderVariableStatus fact={fact} editable={false} onChoose={noop} />,
      accessibilityLabel: fact => fact.key,
      columnTitles: anatomy.columnTitles,
    }), [anatomy.columnTitles]);

    const save = async (): Promise<boolean> => {
      setOutcome(null);
      setProviderSave(null);
      try {
        const result = await draft.save();
        if (result) {
          if (result.ok && result.providerVariables) setProviderSave({ lifetime: props.lifetime, environmentId: props.environmentId, result: result.providerVariables });
          void provider.refresh();
        }
        if (result && !result.ok) {
          setOutcome(readDeploymentActionResult(result));
          return false;
        }
        return true;
      } catch (error) {
        const next = readDeploymentActionError(error);
        if (next.kind === 'approval') props.review.request(next.artifactId);
        setOutcome(next);
        if (props.providerTargetLinkId) void provider.refresh();
        return false;
      }
    };
    // Bulk edit's one "Save N changes": its diff lands in the draft first, then this one write follows.
    const [saveQueued, setSaveQueued] = React.useState(false);
    React.useEffect(() => {
      if (!saveQueued || !draft.canSave) return;
      setSaveQueued(false);
      void save().then((ok) => {
        if (ok) setMode('table');
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [saveQueued, draft.canSave]);
    // How a kept source reads in the file: a Saved Secret by its name, a reference by its Environment.
    const environmentName = props.environmentName;
    const label = React.useMemo<EnvironmentBulkSourceLabel>(() => (source) => {
      if (source.kind === 'secret') {
        const name = catalog.find((entry) => entry.ref === source.ref)?.name;
        return name ? `saved: ${name}` : `saved secret · revision ${source.resourceRevision}`;
      }
      if (source.kind === 'reference') {
        return `${source.export} from ${environmentName(source.environmentId) ?? t('projects.deployments.sourceAnotherEnvironment')}`;
      }
      return sourceTitle({ source }, environmentName).toLowerCase();
    }, [catalog, environmentName]);
    const savedName = (source: SecretSource) =>
      catalog.find((entry) => entry.ref === source.ref)?.name ?? t('projects.deployments.sourceSavedSecret');
    const secrets = rows.filter(
      (row) => row.binding.source.kind === 'secret',
    ).length;
    // K-P42: a secret linked into a Team Environment reaches whoever controls its Machines. Linking is the
    // approval, so this is one quiet line beside the secrets (shown as soon as one is added, before Save).
    const teamDisclosure = editor.rows.some(
      (row) => row.secretDisclosure?.kind === 'teamEnvironmentMachines',
    );
    const saveActions = draft.dirty && mode === 'table' ? (
      <>
        <SectionActionButton
          testID="project-deployments.environment.variables.discard"
          title={t('common.discard')}
          icon="x"
          disabled={draft.saving}
          onPress={() => {
            setOutcome(null);
            draft.cancel();
          }}
        />
        <RoundButton
          testID="project-deployments.environment.variables.save"
          size="small"
          title={t('common.save')}
          loading={draft.saving}
          disabled={!draft.canSave}
          onPress={() => {
            void save();
          }}
        />
      </>
    ) : null;
    // Table | Bulk edit, then Add (lab d2 `variables`): editing a list of names and pasting a .env are two
    // views of the same draft; Save stays the one write.
    const actions = draft.canEdit ? (
      <View style={styles.actions}>
        <SegmentedTabBar<PanelMode>
          testIDPrefix="project-deployments.environment.variables.mode"
          accessibilityLabel={t('projects.deployments.variablesTitle')}
          compact
          segmentSizing="content"
          role="radiogroup"
          activeTabId={mode}
          onSelectTab={(next) => {
            setAdding(null);
            if (next === 'table') editor.cancelBulk();
            setMode(next);
          }}
          tabs={[
            { id: 'table', label: t('projects.deployments.variablesModeTable') },
            { id: 'bulk', label: t('projects.deployments.variablesModeBulk') },
          ]}
        />
        {saveActions ?? (mode === 'table' ? (
          <AddMenu
            disabled={adding !== null}
            secretsAvailable={props.scope !== null}
            savedAvailable={props.lifetime !== null}
            referenceAvailable={(props.referenceTargets ?? NO_REFERENCE_TARGETS).length > 0
              || (props.referenceEnvironments?.size ?? 0) > 1}
            onSelect={(choice) => {
              if (choice === 'paste') setMode('bulk');
              else if (choice === 'saved') void pickSaved();
              else setAdding(choice);
            }}
          />
        ) : null)}
      </View>
    ) : undefined;

    return (
      <ItemGroup
        testID="project-deployments.environment.variables"
        title={props.title ?? t('projects.deployments.variablesTitle')}
        titleAccessory={
          rows.length > 0 ? (
            <ManagedSectionCount count={rows.length} />
          ) : undefined
        }
        description={props.description ?? t('projects.deployments.variablesDescription')}
        action={actions}
        surface="none"
      >
        {outcome ? (
          <SaveOutcome
            outcome={outcome}
            pending={
              outcome.kind === 'approval' &&
              props.review.pendingId === outcome.artifactId
            }
            onOpenReview={props.review.open}
          />
        ) : null}
        {props.providerTargetLinkId && provider.loading && !provider.value ? <SurfaceStateCard size="line" kind="loading"
          testID="project-deployments.environment.variables.provider.loading" title={t('common.loading')} /> : null}
        {props.providerTargetLinkId && provider.failure ? <SurfaceStateCard size="line" kind="error"
          testID="project-deployments.environment.variables.provider.unavailable"
          title={t('projects.deployments.providerVariablesUnavailable')} diagnosticCode={provider.failure}
          action={{ label: t('common.retry'), onPress: () => { void provider.refresh(); } }} /> : null}
        {providerSave && providerSave.failures.length > 0 ? <AttentionBanner tone="warning"
          testID="project-deployments.environment.variables.provider.partial"
          title={t('projects.deployments.providerVariablesPartial')}
          details={providerSave.failures.map(failure => `${failure.key}: ${failure.code}`)} /> : null}
        {providerOnly.length > 0 ? <CoreCollectionScope>
          <Collection<DeploymentTargetVariableMetadataV1> model={providerOnlyModel} anatomy={providerOnlyAnatomy}
            testID="project-deployments.environment.variables.provider.unbound"
            accessibilityLabel={t('projects.deployments.providerVariablesColumn')}
            presentation="list" detail="none" scroll="page" minListWidth={TABLE_MIN_WIDTH_PX}
            minDetailWidth={TABLE_MIN_WIDTH_PX} preferredListRatio={1} />
        </CoreCollectionScope> : null}
        {mode === 'table' && rotated.size > 0 && rows.some(row => rowRotation(row, rotated) !== null) ? (
          <AttentionBanner
            testID="project-deployments.environment.variables.rotated"
            tone="warning"
            title={t('projects.deployments.editors.rotatedTitle')}
            description={t('projects.deployments.editors.rotatedBody')}
            action={stale.length > 0 && editable ? {
              label: t('projects.deployments.editors.useNewRevision'),
              onPress: () => {
                // One draft edit for every stale row; Save stays the one `deployments.bindings.set` write.
                const bindings: VariableBinding[] = [];
                const identities: string[] = [];
                for (const row of stale) {
                  const source = row.binding.source;
                  const revision = rowRotation(row, rotated);
                  if (source.kind !== 'secret' || revision === null) continue;
                  const phases = row.phase === 'both' ? (['build', 'runtime'] as const) : [row.phase];
                  bindings.push(...phases.map(phase => ({ ...row.binding, phase, source: { ...source, resourceRevision: revision } })));
                  identities.push(...row.identities);
                }
                editor.putMany(bindings, identities);
              },
            } : stale.length === 0 && !draft.dirty && props.onDeploy ? {
              label: t('projects.deployments.deploy'),
              onPress: props.onDeploy,
            } : null}
          />
        ) : null}
        {draft.conflict ? (
          <AttentionBanner
            testID="project-deployments.environment.variables.conflict"
            tone="neutral"
            title={t('projects.deployments.variablesConflictTitle')}
            description={t('projects.deployments.variablesConflictBody')}
            action={{ label: t('common.discard'), onPress: draft.cancel }}
          />
        ) : null}
        {mode === 'bulk' ? (
          <BulkEditor
            editor={editor}
            saved={saved}
            label={label}
            environmentName={props.environmentName(props.environmentId) ?? ''}
            saving={draft.saving || saveQueued}
            onSave={() => setSaveQueued(true)}
            onCancel={() => {
              editor.cancelBulk();
              setMode('table');
            }}
          />
        ) : null}
        {mode === 'table' && adding === 'reference' ? (
          <AddReferenceVariable
            draftKey={draftKey}
            projectSourceId={props.projectSourceId}
            taken={rows}
            targets={props.referenceTargets ?? NO_REFERENCE_TARGETS}
            currentEnvironmentId={props.environmentId}
            environments={props.referenceEnvironments ?? NO_REFERENCE_ENVIRONMENTS}
            read={props.domainRead ?? null}
            serverId={props.scope?.serverId ?? props.controlTarget?.serverId}
            environmentName={props.environmentName}
            onCancel={() => setAdding(null)}
            onAdd={(name, target) => {
              const result = editor.setVariable({ name, phase: 'runtime', source: { kind: 'reference',
                environmentId: target.environmentId, export: target.export, via: 'auto' } });
              if (result.ok) setAdding(null);
              return result.ok;
            }}
          />
        ) : mode === 'table' && adding ? (
          <AddValueVariable
            taken={rows}
            secret={adding === 'secret'}
            valueReady={adding !== 'fact' || fact !== 'domainUrl' || factDomainId !== null}
            valueControl={adding === 'fact' ? <>
              <DropdownMenu testID="project-deployments.environment.variables.add.fact-choice"
                open={factOpen} onOpenChange={setFactOpen}
                items={DeploymentVariableFactOptionsV1.map(value => ({ id: value, title: factTitle(value) }))}
                selectedId={fact} onSelect={value => {
                  const selected = DeploymentVariableFactOptionsV1.find(choice => choice === value);
                  if (selected) setFact(selected);
                  setFactOpen(false);
                }} itemTrigger={{ title: t('projects.deployments.settingsSections.previewEditor.addFact'),
                  detailFormatter: () => factTitle(fact), itemProps: { accessoryLayout: 'adaptive' } }} />
              {fact === 'domainUrl' ? props.domainRead ? <DeploymentEnvironmentDomainSelect {...props.domainRead}
                environmentId={props.environmentId} selectedId={factDomainId} onSelect={setFactDomainId}
                disabled={draft.saving} title={t('projects.deployments.factDomainUrl')}
                testID="project-deployments.environment.variables.add.fact-domain"
                stateTestID="project-deployments.environment.variables.add.fact-domain-state" />
                : <SurfaceStateCard kind="unavailable" size="line" title={t('common.unavailable')} /> : null}
            </> : undefined}
            bound={adding === 'saved' && picked ? savedName(picked) : null}
            status={saved.status}
            onCancel={() => setAdding(null)}
            onAdd={async (name, value) => {
              if (adding === 'fact') {
                if (fact === 'domainUrl' && !factDomainId) return false;
                const source: Extract<VariableBinding['source'], { kind: 'deploymentFact' }> = fact === 'domainUrl'
                  ? { kind: 'deploymentFact', fact, domainId: factDomainId! } : { kind: 'deploymentFact', fact };
                const result = editor.setVariable({ name, phase: 'runtime', source });
                if (result.ok) setAdding(null);
                return result.ok;
              }
              if (adding === 'saved') {
                const result = picked ? editor.setVariable({ name, phase: 'runtime', source: picked }) : { ok: false };
                if (result.ok) setAdding(null);
                return result.ok;
              }
              if (adding === 'secret') {
                const result = await saved.createAndBind({ name, value, phase: 'runtime' });
                if (result.ok) setAdding(null);
                return result.ok;
              }
              const result = editor.setVariable({
                name,
                phase: 'runtime',
                source: { kind: 'value', value },
              });
              if (result.ok) setAdding(null);
              return result.ok;
            }}
          />
        ) : null}
        {mode === 'bulk' ? null : rows.length === 0 ? (
          adding ? null : (
            // An empty file invites the three ways in (lab d2 `addvar`), not a bare line.
            <SurfaceStateCard
              testID="project-deployments.environment.variables.empty"
              kind="empty"
              size="details"
              layout="inline"
              title={t('projects.deployments.variablesEmpty')}
              reason={t('projects.deployments.variablesEmptyBody')}
              {...(draft.canEdit ? {
                action: props.lifetime
                  ? { label: t('projects.deployments.addSaved'), onPress: () => { void pickSaved(); } }
                  : { label: t('projects.deployments.addPlain'), onPress: () => setAdding('plain') },
                secondaryAction: { label: t('projects.deployments.addPaste'), onPress: () => setMode('bulk') },
              } : {})}
            />
          )
        ) : (
          <CoreCollectionScope>
            <Collection<VariableRow>
              testID="project-deployments.environment.variables.table"
              model={model}
              anatomy={anatomy}
              accessibilityLabel={t('projects.deployments.variablesTitle')}
              presentation={props.phone ? 'list' : 'table'}
              detail="none"
              scroll="page"
              minListWidth={TABLE_MIN_WIDTH_PX}
              minDetailWidth={TABLE_MIN_WIDTH_PX}
              preferredListRatio={1}
            />
          </CoreCollectionScope>
        )}
        {mode === 'table' ? <DeploymentSecretBindingsNotice
          bindings={editor.rows.map(row => row.binding)} scope={props.scope} controlTarget={props.controlTarget} /> : null}
        {mode === 'table' && disclosedRow && disclosedEntry && props.scope ? (
          <ItemGroup title={disclosedRow.name} action={<SectionActionButton
            testID={`project-deployments.environment.variable.${disclosedRow.name}.value.close`}
            title={t('common.close')} icon="x" onPress={() => setDisclosedKey(null)} />}>
            <SharedSavedSecretValueItem
              key={JSON.stringify([props.environmentId, props.scope.serverId, props.scope.accountId, disclosedEntry.ref])}
              testID={`project-deployments.environment.variable.${disclosedRow.name}.value`}
              scope={props.scope} entry={disclosedEntry} active />
          </ItemGroup>
        ) : null}
        {mode === 'table' && secrets > 0 && (props.sealedOn || teamDisclosure) ? (
          <View
            testID="project-deployments.environment.variables.sealed"
            style={styles.sealed}
          >
            <Icon name="lock" size={14} color={theme.colors.text.tertiary} />
            <Text
              variant="meta"
              style={[
                styles.sealedText,
                { color: theme.colors.text.secondary },
              ]}
            >
              {teamDisclosure
                ? props.sealedOn
                  ? t('projects.deployments.secretsSealedTeam', { count: secrets, machine: props.sealedOn })
                  : t('projects.deployments.secretsTeamDisclosure', { count: secrets })
                : t('projects.deployments.secretsSealed', {
                  count: secrets,
                  machine: props.sealedOn ?? '',
                })}
            </Text>
          </View>
        ) : null}
      </ItemGroup>
    );
  },
);

/** "Runtime ⌄": the row's one phase control (lab round 9 K12); each choice says what it means. */
function PhaseMenu(
  props: Readonly<{
    row: VariableRow;
    disabled: boolean;
    onSelect: (phase: Phase) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const id = `project-deployments.environment.variable.${props.row.name}.phase`;
  const items = React.useMemo(() => phaseItems(props.row, id), [id, props.row]);
  if (props.disabled)
    return (
      <Text style={styles.phase} numberOfLines={1}>
        {phaseLabel(props.row.phase)}
      </Text>
    );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={props.row.phase}
      matchTriggerWidth={false}
      maxWidthCap={320}
      popoverAccessibilityLabel={t('projects.deployments.columnUsedAt')}
      onSelect={(itemId) => props.onSelect(itemId as Phase)}
      trigger={({ toggle }) => (
        <Pressable
          testID={id}
          accessibilityRole="button"
          accessibilityLabel={`${t('projects.deployments.columnUsedAt')}: ${phaseLabel(props.row.phase)}`}
          aria-expanded={open}
          onPress={toggle}
          style={({ pressed }) => [
            styles.phaseTrigger,
            (pressed || open) && {
              backgroundColor: theme.colors.surface.pressed,
            },
          ]}
        >
          <Text style={styles.phase} numberOfLines={1}>
            {phaseLabel(props.row.phase)}
          </Text>
          <Icon
            name="caret-down"
            size={12}
            color={theme.colors.text.tertiary}
          />
        </Pressable>
      )}
    />
  );
}

/** The row's ⋯: its rare operations. On a phone, where the table's phase column is gone, it also holds "Used at". */
function VariableRowMenu(
  props: Readonly<{
    row: VariableRow;
    disabled: boolean;
    withPhase: boolean;
    onPhase: (phase: Phase) => void;
    onRemove: () => void;
    onReveal?: () => void;
    onRotate?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const id = `project-deployments.environment.variable.${props.row.name}.menu`;
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      // The three phases lead the menu as its first group, each saying what it means.
      ...(props.withPhase && !props.disabled
        ? phaseItems(props.row, `${id}.phase`).map((item) => ({ ...item, category: 'phase' }))
        : []),
      ...(props.onReveal ? [{ id: 'reveal', category: 'operations', testID: `${id}.reveal`,
        title: t('secretsSettings.revealValue') }] : []),
      ...(props.onRotate ? [{ id: 'rotate', category: 'operations', testID: `${id}.rotate`,
        title: t('secrets.actions.replaceValue') }] : []),
      ...(!props.disabled ? [{
        id: 'remove',
        category: 'operations',
        testID: `${id}.remove`,
        title: t('projects.deployments.removeVariable'),
        destructive: true,
        icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
      }] : []),
    ],
    [id, props.row, props.withPhase, props.disabled, props.onReveal, props.onRotate, theme.colors.text.secondary],
  );
  if (items.length === 0) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={props.row.name}
      separateCategories
      onSelect={(itemId) => {
        if (itemId === 'remove') props.onRemove();
        else if (itemId === 'reveal') props.onReveal?.();
        else if (itemId === 'rotate') props.onRotate?.();
        else if (PHASES.includes(itemId as Phase))
          props.onPhase(itemId as Phase);
      }}
      trigger={({ toggle }) => (
        <IconButton
          testID={id}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('common.more')}
          onPress={toggle}
        />
      )}
    />
  );
}

function phaseItems(row: VariableRow, idPrefix: string): DropdownMenuItem[] {
  return PHASES.map((phase) => ({
    id: phase,
    testID: `${idPrefix}.${phase}`,
    title: phaseLabel(phase),
    subtitle: phaseHint(phase),
    checked: row.phase === phase,
  }));
}

/** Add → Value: a name and its plain value, used at Runtime until the row's own control says otherwise. */
function AddValueVariable(
  props: Readonly<{
    taken: readonly VariableRow[];
    /** New secret: the value is saved under Settings → Secrets (masked here) and the row binds to it. */
    secret: boolean;
    /** A saved secret already picked: only its name here is asked for. */
    bound?: string | null;
    status: SavedSecretBindings['status'];
    valueControl?: React.ReactNode;
    valueReady?: boolean;
    onCancel: () => void;
    onAdd: (name: string, value: string) => boolean | Promise<boolean>;
  }>,
) {
  const { theme } = useUnistyles();
  // A picked saved secret proposes its own name as the variable's ("Stripe live key" → STRIPE_LIVE_KEY).
  const [name, setName] = React.useState(() => props.bound
    ? props.bound.toUpperCase().replace(/[^A-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '').replace(/^(?=\d)/u, '_')
    : '');
  const [value, setValue] = React.useState('');
  const [failed, setFailed] = React.useState(false);
  const busy = props.status !== 'idle';
  const trimmed = name.trim();
  const duplicate = props.taken.some((row) => row.name === trimmed);
  return (
    <InlineAddExpander
      isOpen
      onOpenChange={(next) => {
        if (!next) props.onCancel();
      }}
      title={props.bound ? t('projects.deployments.addSavedTitle') : props.secret ? t('projects.deployments.addSecretTitle') : t('projects.deployments.addVariable')}
      trigger={null}
      onCancel={props.onCancel}
      onSave={() => {
        void Promise.resolve(props.onAdd(trimmed, value)).then((ok) => setFailed(!ok));
      }}
      saveDisabled={trimmed.length === 0 || duplicate || busy || props.valueReady === false || (props.secret && !props.bound && value.length === 0)}
      cancelLabel={t('common.cancel')}
      saveLabel={t('common.add')}
      saveTestID="project-deployments.environment.variables.add.save"
      cancelTestID="project-deployments.environment.variables.add.cancel"
    >
      <View style={styles.addFields}>
        <FieldTextInput
          testID="project-deployments.environment.variables.add.name"
          value={name}
          onChangeText={(next) => {
            setFailed(false);
            setName(next.toUpperCase());
          }}
          monospace
          autoCapitalize="characters"
          accessibilityLabel={t('projects.deployments.columnName')}
          placeholder={props.secret || props.bound ? 'STRIPE_SECRET_KEY' : 'LOG_LEVEL'}
          error={
            duplicate
              ? t('projects.deployments.variableExists')
              : failed
                ? t('projects.deployments.variableInvalid')
                : null
          }
        />
        {props.bound ? (
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('projects.deployments.addSavedBound', { name: props.bound })}
          </Text>
        ) : null}
        {props.bound ? null : props.valueControl ?? <FieldTextInput
          testID="project-deployments.environment.variables.add.value"
          value={value}
          onChangeText={setValue}
          monospace
          accessibilityLabel={t('projects.deployments.sourceValue')}
          placeholder={props.secret ? '' : 'info'}
          secureTextEntry={props.secret}
        />}
        {props.secret ? (
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {props.status === 'waitingApproval'
              ? t('projects.deployments.secretWaitingApproval')
              : props.status !== 'idle'
                ? t('projects.deployments.secretSaving')
                : t('projects.deployments.addSecretHint')}
          </Text>
        ) : null}
      </View>
    </InlineAddExpander>
  );
}

/** Add → Point at another service (lab `variables/refpick`): a name and the service export it resolves to on deploy. */
function AddReferenceVariable(
  props: Readonly<{
    /** Where the open form keeps what was typed (`useInlineAddDraftField`). */
    draftKey: string;
    /** This Environment's Project; the "share one" link names it for this Environment's own Settings. */
    projectSourceId?: string;
    taken: readonly VariableRow[];
    targets: readonly VariableReferenceTarget[];
    /** Two steps (DEPLOY-UI-LOGIC-B 10:25Z contract): the Environment, this one first, then the services it shares. */
    currentEnvironmentId: string;
    environments: VariableReferenceEnvironments;
    read: Pick<React.ComponentProps<typeof DeploymentEnvironmentDomainSelect>, 'controller' | 'demand'> | null;
    serverId?: string;
    environmentName: (environmentId: string) => string | null;
    onCancel: () => void;
    onAdd: (name: string, target: VariableReferenceTarget) => boolean;
  }>,
) {
  const router = useRouter();
  const [name, setName] = useInlineAddDraftField(props.draftKey, 'referenceName', '');
  const [environmentId, setEnvironmentId] = useInlineAddDraftField(props.draftKey, 'referenceEnvironment', props.currentEnvironmentId);
  const [targetKey, setTargetKey] = useInlineAddDraftField<string | null>(props.draftKey, 'referenceTarget', null);
  const [failed, setFailed] = React.useState(false);
  const other = environmentId !== props.currentEnvironmentId;
  // Another Environment's shared services come from its exact record, read only while it is the chosen one.
  const record = useDeploymentEnvironmentRecord(props.read?.controller ?? null, other ? environmentId : null,
    props.read?.demand ?? HIDDEN_REFERENCE_READ);
  const otherDetail = other ? record.snapshot.value : null;
  const targets = React.useMemo<readonly VariableReferenceTarget[]>(() => !other ? props.targets
    : (otherDetail?.content.ownServer?.serviceExports ?? []).filter(isPrivateServiceExport).map(entry => ({ environmentId, export: entry.key,
        service: entry.service, network: privateServiceExportReachLabel(entry) })),
  [environmentId, other, otherDetail, props.targets]);
  const keyFor = (target: VariableReferenceTarget) => JSON.stringify([target.environmentId, target.export]);
  const target = targets.find(item => keyFor(item) === targetKey) ?? null;
  const trimmed = name.trim();
  const duplicate = props.taken.some((row) => row.name === trimmed);
  const environmentTitle = props.environments.get(environmentId)?.name ?? props.environmentName(environmentId) ?? '';
  const shareTarget = other ? otherDetail?.environment ?? null
    : props.serverId && props.projectSourceId ? { serverId: props.serverId, projectSourceId: props.projectSourceId } : null;
  const shareRoute = shareTarget ? deploymentEnvironmentRoute({ serverId: shareTarget.serverId,
    projectSourceId: shareTarget.projectSourceId, environmentId, tab: 'settings', section: 'sharing' }) : null;
  const loading = other && otherDetail === null && record.snapshot.status !== 'unavailable';
  const unreadable = other && otherDetail === null && record.snapshot.status === 'unavailable';
  const machineIds = React.useMemo(() => Array.from(props.environments.values()).flatMap(entry => entry.machineIds),
    [props.environments]);
  const machineNames = useMachineDisplayNamesById(machineIds, { serverId: props.serverId });
  const environmentItems = React.useMemo(() => {
    const ids = [props.currentEnvironmentId, ...Array.from(props.environments.keys()).filter(id => id !== props.currentEnvironmentId)];
    return ids.map(id => {
      const environment = props.environments.get(id);
      const subtitle = environment?.machineIds.flatMap(machineId => machineNames[machineId] ? [machineNames[machineId]] : []).join(', ');
      return { id, title: environment?.name ?? props.environmentName(id) ?? id, subtitle: subtitle || undefined };
    });
  }, [machineNames, props.currentEnvironmentId, props.environments, props.environmentName]);
  return (
    <InlineAddExpander
      isOpen
      onOpenChange={(next) => { if (!next) props.onCancel(); }}
      title={t('projects.deployments.editors.addReferenceTitle')}
      trigger={null}
      onCancel={props.onCancel}
      onSave={() => { if (target) setFailed(!props.onAdd(trimmed, target)); }}
      saveDisabled={trimmed.length === 0 || duplicate || target === null}
      cancelLabel={t('common.cancel')}
      saveLabel={t('common.add')}
      saveTestID="project-deployments.environment.variables.add.save"
      cancelTestID="project-deployments.environment.variables.add.cancel"
    >
      {/* Each field says what it is, one width for all (PAGE-ACCEPT-176 R8-D3). */}
      <View style={styles.addFields}>
        <FieldItem label={t('projects.deployments.columnName')}>
          <FieldTextInput
            testID="project-deployments.environment.variables.add.name"
            value={name}
            onChangeText={(next) => { setFailed(false); setName(next.toUpperCase()); }}
            monospace
            autoCapitalize="characters"
            accessibilityLabel={t('projects.deployments.columnName')}
            placeholder="DATABASE_URL"
            error={duplicate ? t('projects.deployments.variableExists') : failed ? t('projects.deployments.variableInvalid') : null}
          />
        </FieldItem>
        {environmentItems.length > 1 ? (
          <FieldItem label={t('projects.deployments.settingsSections.referenceEnvironment')}>
            <ValueFieldSelect
              testID="project-deployments.environment.variables.add.referenceEnvironment"
              label={t('projects.deployments.settingsSections.referenceEnvironment')}
              items={environmentItems}
              selectedId={environmentId}
              onSelect={(next) => { setEnvironmentId(next); setTargetKey(null); }}
              fill
            />
          </FieldItem>
        ) : null}
        {loading ? (
          <SurfaceStateCard testID="project-deployments.environment.variables.add.referenceLoading" size="line" kind="loading"
            title={t('common.loading')} />
        ) : unreadable ? (
          <SurfaceStateCard testID="project-deployments.environment.variables.add.referenceUnavailable" size="line" kind="unavailable"
            title={t('common.unavailable')} action={{ label: t('common.retry'), onPress: () => { void record.refresh(); } }} />
        ) : targets.length === 0 ? (
          <View testID="project-deployments.environment.variables.add.referenceNone">
            <Text variant="meta" style={styles.referenceNone}>
              {t('projects.deployments.settingsSections.referenceNone', { environment: environmentTitle })}
            </Text>
            {/* The sentence leads to where that Environment shares one (PAGE-ACCEPT-176 R8-D2). */}
            {shareRoute ? <TextLinkButton testID="project-deployments.environment.variables.add.referenceNone.share" size="meta"
              label={t('projects.deployments.settingsSections.referenceNoneShare')} onPress={() => router.push(shareRoute)} /> : null}
          </View>
        ) : (
          <FieldItem label={t('projects.deployments.editors.referenceTarget')}>
            <ValueFieldSelect
              testID="project-deployments.environment.variables.add.reference"
              label={t('projects.deployments.editors.referenceTarget')}
              items={targets.map(item => ({ id: keyFor(item),
                // A service shared under its own name says it once.
              title: item.service === item.export ? item.service : `${item.service} · ${item.export}`,
                ...(item.network ? { subtitle: item.network } : {}) }))}
              selectedId={targetKey}
              onSelect={setTargetKey}
              fill
            />
          </FieldItem>
        )}
      </View>
    </InlineAddExpander>
  );
}

/** "+ Add" (lab d2 `addvar`): a new secret, a plain variable, or a pasted .env. */
function AddMenu(
  props: Readonly<{
    disabled: boolean;
    secretsAvailable: boolean;
    savedAvailable: boolean;
    referenceAvailable: boolean;
    onSelect: (choice: Adding | 'paste') => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const id = 'project-deployments.environment.variables.add';
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      // Binding one already saved leads (lab d2 `addvar`): it is the usual way a secret arrives.
      ...(props.savedAvailable
        ? [{
            id: 'saved',
            testID: `${id}.saved`,
            title: t('projects.deployments.addSaved'),
            subtitle: t('projects.deployments.addSavedHint'),
            icon: <Icon name="key" size={16} color={theme.colors.text.secondary} />,
          }]
        : []),
      ...(props.secretsAvailable
        ? [{
            id: 'secret',
            subtitle: t('projects.deployments.addSecretHint'),
            testID: `${id}.secret`,
            title: t('projects.deployments.addSecret'),
            icon: <Icon name="lock" size={16} color={theme.colors.text.secondary} />,
          }]
        : []),
      {
        id: 'plain',
        testID: `${id}.plain`,
        title: t('projects.deployments.addPlain'),
        icon: <Icon name="code" size={16} color={theme.colors.text.secondary} />,
      },
      ...(props.referenceAvailable
        ? [{
            id: 'reference',
            testID: `${id}.reference`,
            title: t('projects.deployments.editors.addReference'),
            subtitle: t('projects.deployments.editors.addReferenceHint'),
            icon: <Icon name="link" size={16} color={theme.colors.text.secondary} />,
          }]
        : []),
      {
        id: 'fact',
        testID: `${id}.fact`,
        title: t('projects.deployments.settingsSections.previewEditor.addFact'),
        subtitle: t('projects.deployments.sourceFactDetail'),
        icon: <Icon name="code" size={16} color={theme.colors.text.secondary} />,
      },
      {
        id: 'paste',
        category: 'paste',
        testID: `${id}.paste`,
        title: t('projects.deployments.addPaste'),
        icon: <Icon name="file-text" size={16} color={theme.colors.text.secondary} />,
      },
    ],
    [props.referenceAvailable, props.savedAvailable, props.secretsAvailable, theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('projects.deployments.addVariable')}
      separateCategories
      onSelect={(choice) => props.onSelect(choice as Adding | 'paste')}
      trigger={({ toggle }) => (
        <SectionActionButton
          testID={id}
          title={t('projects.deployments.addVariable')}
          icon="plus"
          expanded={open}
          disabled={props.disabled}
          onPress={toggle}
        />
      )}
    />
  );
}

/**
 * Bulk edit (lab d2 `bulk`): the whole Variables file as text. Every current entry is there, secrets and other
 * sources as ‹references›, never values. Edits, new lines and deleted lines read back as one diff (“+1 secret ·
 * 1 changed · nothing removed”) and one “Save N changes”: new secret values are saved under Settings → Secrets
 * first, then the section's one `deployments.bindings.set` writes the file. References created before a failure
 * are kept and reused on the next Save, never created twice or deleted.
 */
function BulkEditor(
  props: Readonly<{
    editor: BindingsDraft['editor'];
    saved: SavedSecretBindings;
    label: EnvironmentBulkSourceLabel;
    environmentName: string;
    saving: boolean;
    onSave: () => void;
    onCancel: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { editor, saved, label } = props;
  const [initialInput] = React.useState<NonNullable<BindingsDraft['editor']['bulkInput']>>(() => ({
    text: `${t('projects.deployments.bulkHeader', { name: props.environmentName })}\n${editor.bulkText(label)}\n`,
    kinds: {},
    sources: {},
  }));
  const input = editor.bulkInput ?? initialInput;
  const { text, kinds, sources: created } = input;
  const [error, setError] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const { stageBulk, classifyBulk } = editor;
  React.useEffect(() => {
    editor.setBulkInput(input);
    const result = stageBulk(text, 'runtime', label);
    setError(result.ok ? null : result.error);
    setFailure(null);
    if (result.ok) for (const [name, kind] of Object.entries(kinds)) classifyBulk(name, kind);
    // Re-read only when the text or a choice changes, not on the editor's own echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, kinds]);
  const rows = editor.bulk ?? [];
  const removed = editor.bulkRemoved ?? [];
  const added = rows.filter((row) => row.change === 'added');
  const addedSecrets = added.filter((row) => row.classification === 'secret');
  const addedPlain = added.filter((row) => row.classification === 'plain');
  const changed = rows.filter((row) => row.change === 'changed');
  // Only a new name asks how its value is kept; an edited value keeps its kind.
  const literals = added.filter((row) => row.source === null);
  const count = rows.length + removed.length;
  const reused = Object.keys(created).length;
  const busy = saved.busy || props.saving;
  const apply = async () => {
    setFailure(null);
    // Saved Secrets are reached only when a new secret value must be saved first.
    const creates = rows.some((row) => row.source === null && row.classification === 'secret' && !Object.hasOwn(created, row.name));
    const result = creates ? await saved.applyBulk(created) : { ...editor.applyBulk(created), sources: created };
    if (result.ok) {
      props.onSave();
      return;
    }
    // Keep every Secret already created: the next Save binds them instead of creating them again.
    editor.setBulkInput({ ...input, sources: result.sources });
    setFailure(result.error);
  };
  const part = (key: string, lead: string, names: readonly string[]) => (
    <Text key={key} variant="meta" style={{ color: theme.colors.text.secondary }}>
      <Text variant="meta" emphasis="medium" style={{ color: theme.colors.text.primary }}>{lead}</Text>
      {names.length > 0 ? ` ${names.join(', ')}` : ''}
    </Text>
  );
  return (
    <View testID="project-deployments.environment.variables.bulk" style={styles.bulk}>
      <FieldTextInput
        testID="project-deployments.environment.variables.bulk.text"
        value={text}
        onChangeText={(next) => {
          editor.setBulkInput({ ...input, text: next });
        }}
        multiline
        growWithText
        minLines={8}
        monospace
        autoCapitalize="none"
        editable={!busy && reused === 0}
        accessibilityLabel={t('projects.deployments.variablesModeBulk')}
        placeholder={t('projects.deployments.bulkPlaceholder')}
      />
      {literals.length > 0 ? (
        <ListPresentationProvider value="page" pageInsets="contained">
          <ItemGroup
            testID="project-deployments.environment.variables.bulk.rows"
            title={t('projects.deployments.bulkDecide')}
          >
            {literals.map((row) => (
              <Item
                key={`${row.name}:${row.phase}`}
                testID={`project-deployments.environment.variables.bulk.${row.name}`}
                title={row.name}
                titleStyle={styles.mono}
                subtitle={Object.hasOwn(created, row.name)
                  ? t('projects.deployments.bulkSecretSaved')
                  : row.classification === 'plain' ? row.value : MASK.slice(0, Math.max(8, Math.min(MASK.length, row.value.length)))}
                subtitleStyle={styles.mono}
                mode="info"
                rightElement={(
                  <SegmentedTabBar<'secret' | 'plain'>
                    testIDPrefix={`project-deployments.environment.variables.bulk.${row.name}.kind`}
                    accessibilityLabel={row.name}
                    compact
                    segmentSizing="content"
                    role="radiogroup"
                    disabled={busy || Object.hasOwn(created, row.name)}
                    activeTabId={row.classification}
                    onSelectTab={(next) => editor.setBulkInput({ ...input, kinds: { ...kinds, [row.name]: next } })}
                    tabs={[
                      { id: 'secret', label: t('projects.deployments.bulkSecret') },
                      { id: 'plain', label: t('projects.deployments.bulkPlain') },
                    ]}
                  />
                )}
              />
            ))}
          </ItemGroup>
        </ListPresentationProvider>
      ) : null}
      <View testID="project-deployments.environment.variables.bulk.diff" style={styles.bulkFooter}>
        <View style={styles.bulkSummary}>
          {error ?? failure ? (
            <Text variant="meta" style={{ color: theme.colors.state.danger.textForeground }}>
              {/* The two parse refusals say what to fix; a save refusal says nothing changed. */}
              {(error ?? failure) === 'unknown_reference'
                ? t('projects.deployments.bulkUnknownReference')
                : (error ?? failure) === 'invalid_binding'
                  ? t('projects.deployments.bulkInvalidLine')
                  : t('projects.deployments.bulkFailed')}
            </Text>
          ) : saved.status === 'waitingApproval' ? (
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('projects.deployments.secretWaitingApproval')}
            </Text>
          ) : reused > 0 ? (
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('projects.deployments.bulkReused', { count: reused })}
            </Text>
          ) : count === 0 ? (
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('projects.deployments.bulkNoChanges')}
            </Text>
          ) : (
            <View style={styles.diffParts}>
              {addedSecrets.length > 0
                ? part('secrets', t('projects.deployments.bulkAddedSecrets', { count: addedSecrets.length }), addedSecrets.map((row) => row.name))
                : null}
              {addedPlain.length > 0
                ? part('plain', t('projects.deployments.bulkAddedPlain', { count: addedPlain.length }), addedPlain.map((row) => row.name))
                : null}
              {changed.length > 0
                ? part('changed', t('projects.deployments.bulkChanged', { count: changed.length }), changed.map((row) => row.name))
                : null}
              {removed.length > 0
                ? part('removed', t('projects.deployments.bulkRemoved', { count: removed.length }), removed)
                : (
                  <Text key="removed" variant="meta" style={{ color: theme.colors.text.secondary }}>
                    {t('projects.deployments.bulkNothingRemoved')}
                  </Text>
                )}
            </View>
          )}
        </View>
        <View style={styles.bulkActions}>
        <SectionActionButton
          testID="project-deployments.environment.variables.bulk.cancel"
          title={t('common.cancel')}
          icon="x"
          disabled={busy}
          onPress={props.onCancel}
        />
        <RoundButton
          testID="project-deployments.environment.variables.bulk.save"
          size="small"
          title={count === 0 ? t('common.save') : t('projects.deployments.bulkSave', { count })}
          loading={busy}
          disabled={busy || error !== null || count === 0}
          onPress={() => {
            void apply();
          }}
        />
        </View>
      </View>
    </View>
  );
}

function SaveOutcome(
  props: Readonly<{
    outcome: DeploymentActionOutcome;
    pending: boolean;
    onOpenReview: () => void;
  }>,
) {
  const { outcome } = props;
  if (outcome.kind === 'approval') {
    if (!props.pending) return null;
    return (
      <AttentionBanner
        testID="project-deployments.environment.variables.review"
        tone="neutral"
        title={t('projects.deployments.reviewWaitingTitle')}
        description={t('projects.deployments.variablesReviewBody')}
        action={{
          label: t('projects.deployments.openReview'),
          onPress: props.onOpenReview,
        }}
      />
    );
  }
  if (outcome.kind !== 'refused') return null;
  if (outcome.failure?.effectAttempted) return <AttentionBanner
    testID="project-deployments.environment.variables.provider.unpersisted" tone="warning"
    title={t('projects.deployments.providerVariablesUnpersisted')}
    description={t('projects.deployments.providerVariablesUnpersistedBody')} details={[outcome.code]} />;
  return (
    <AttentionBanner
      testID={`project-deployments.environment.variables.refused.${outcome.reason}`}
      tone="danger"
      title={t('projects.deployments.variablesSaveFailedTitle')}
      description={
        outcome.reason === 'permission'
          ? t('projects.deployments.managersOnly')
          : t('projects.deployments.nothingChanged')
      }
      details={[outcome.code]}
    />
  );
}

/** Masked provider facts, beside the authored source. The provider owner decides drift and ownership. */
function ProviderVariableStatus(props: Readonly<{
  fact: DeploymentTargetVariableMetadataV1; choice?: 'useOurs' | 'keepTheirs'; editable: boolean;
  onChoose: (choice: 'useOurs' | 'keepTheirs') => void;
}>) {
  const { fact } = props;
  const prefix = `project-deployments.environment.variables.provider.${fact.key}`;
  const conflict = fact.present && (!fact.owned || fact.drift === 'changed');
  return <View testID={prefix}>
    <Text variant="meta">{[
      fact.present ? t('projects.deployments.providerVariablesPresent') : t('projects.deployments.providerVariablesMissing'),
      fact.secret ? t('projects.deployments.providerVariablesSecret') : t('projects.deployments.providerVariablesPlain'),
      fact.owned ? t('projects.deployments.providerVariablesOwned') : t('projects.deployments.providerVariablesExternal'),
      fact.drift === 'changed' ? t('projects.deployments.providerVariablesChanged')
        : fact.drift === 'unknown' ? t('projects.deployments.providerVariablesUnknown') : null,
    ].filter(Boolean).join(' · ')}</Text>
    {conflict && props.editable ? <>
      <Text variant="meta">{t('projects.deployments.providerVariablesChoiceBody')}</Text>
      <SegmentedTabBar<'useOurs' | 'keepTheirs' | ''>
      accessibilityLabel={fact.key} compact activeTabId={props.choice ?? ''}
      onSelectTab={choice => { if (choice) props.onChoose(choice); }}
      tabs={[
        { id: 'useOurs', label: t('projects.deployments.providerVariablesUseOurs'), testID: `${prefix}.useOurs` },
        { id: 'keepTheirs', label: t('projects.deployments.providerVariablesKeepTheirs'), testID: `${prefix}.keepTheirs` },
      ]} /></> : null}
  </View>;
}

/** The newest saved revision any runtime member does not run yet, per (name, phase); unknown facts say nothing. */
function rotatedSecrets(revisions: SecretRevisions | null): RotatedSecrets {
  if (!revisions || revisions.length === 0) return NO_ROTATED;
  const out = new Map<string, number>();
  for (const member of revisions) {
    for (const fact of member.facts) {
      if (fact.status !== 'redeploy_required' || fact.currentRevision === null) continue;
      const key = rotationKey(fact.name, fact.phase);
      out.set(key, Math.max(out.get(key) ?? 0, fact.currentRevision));
    }
  }
  return out.size === 0 ? NO_ROTATED : out;
}

function rowRotation(row: VariableRow, rotated: RotatedSecrets): number | null {
  if (rotated.size === 0 || row.binding.source.kind !== 'secret') return null;
  const phases = row.phase === 'both' ? (['build', 'runtime'] as const) : [row.phase];
  let newest: number | null = null;
  for (const phase of phases) {
    const revision = rotated.get(rotationKey(row.name, phase));
    if (revision !== undefined) newest = Math.max(newest ?? 0, revision);
  }
  return newest;
}

/** "New revision saved · redeploy to apply": amber, because the running release still uses the old revision. */
function RotatedWord(props: Readonly<{ testID?: string }>) {
  return <StatusWord testID={props.testID} variant="attention" label={t('projects.deployments.editors.secretRotated')} />;
}

/** What the row's value comes from, on one line: a value, a saved secret and its revision, or a reference. */
function ValueSource(
  props: Readonly<{
    binding: VariableBinding;
    environmentName: (id: string) => string | null;
    secretName: (ref: string) => string | null;
    rotatedTestID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const title = sourceTitle(props.binding, props.environmentName, props.secretName);
  const source = props.binding.source;
  const value = source.kind === 'value' && source.value.length > 0;
  // One line (lab envVars): the row's glyph already says the kind, so a secret adds only its revision.
  const revision = source.kind === 'secret'
    ? t('projects.deployments.sourceSecretRevision', { revision: source.resourceRevision }) : null;
  return (
    <Text numberOfLines={1} style={[styles.sourceTitle, value && styles.mono]}>
      {title}
      {revision ? <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{` · ${revision}`}</Text> : null}
      {props.rotatedTestID ? <>{' · '}<RotatedWord testID={props.rotatedTestID} /></> : null}
    </Text>
  );
}

/** A name bound identically for build and runtime reads as one row used at both. */
function variableRows(
  projection: readonly EnvironmentSecretBindingProjectionV1[],
): readonly VariableRow[] {
  const byName = new Map<string, number>();
  const out: VariableRow[] = [];
  for (const { identity, binding } of projection) {
    if (binding.purpose !== 'variable') continue;
    const index = byName.get(binding.name);
    const sibling = index === undefined ? undefined : out[index];
    if (
      sibling &&
      index !== undefined &&
      sibling.phase !== binding.phase &&
      sibling.phase !== 'both' &&
      JSON.stringify(sibling.binding.source) === JSON.stringify(binding.source)
    ) {
      out[index] = {
        ...sibling,
        phase: 'both',
        identities: [...sibling.identities, identity],
      };
      continue;
    }
    byName.set(binding.name, out.length);
    out.push({
      key: identity,
      name: binding.name,
      phase: binding.phase,
      binding,
      identities: [identity],
    });
  }
  return out;
}

function phaseLabel(phase: Phase): string {
  if (phase === 'build') return t('projects.deployments.phaseBuild');
  if (phase === 'runtime') return t('projects.deployments.phaseRuntime');
  return t('projects.deployments.phaseBoth');
}

function phaseHint(phase: Phase): string {
  if (phase === 'build') return t('projects.deployments.phaseBuildHint');
  if (phase === 'runtime') return t('projects.deployments.phaseRuntimeHint');
  return t('projects.deployments.phaseBothHint');
}

function sourceIcon(kind: VariableBinding['source']['kind']) {
  switch (kind) {
    case 'secret':
      return 'key' as const;
    case 'reference':
      return 'link' as const;
    default:
      return 'code' as const;
  }
}

function sourceTitle(
  binding: Pick<VariableBinding, 'source'>,
  environmentName: (id: string) => string | null,
  secretName?: (ref: string) => string | null,
): string {
  const source = binding.source;
  switch (source.kind) {
    case 'secret':
      return secretName?.(source.ref) ?? t('projects.deployments.sourceSavedSecret');
    case 'value':
      return source.value.length > 0
        ? source.value
        : t('projects.deployments.sourceValue');
    case 'reference':
      return t('projects.deployments.sourceReference', {
        output: source.export,
        environment:
          environmentName(source.environmentId) ??
          t('projects.deployments.sourceAnotherEnvironment'),
      });
    case 'deploymentFact':
      return factTitle(source.fact);
  }
}

function factTitle(fact: DeploymentVariableFactV1): string {
  switch (fact) {
    case 'primaryUrl':
      return t('projects.deployments.factPrimaryUrl');
    case 'commitSha':
      return t('projects.deployments.factCommitSha');
    case 'deploymentId':
      return t('projects.deployments.factDeploymentId');
    case 'environmentName':
      return t('projects.deployments.factEnvironmentName');
    case 'domainUrl':
      return t('projects.deployments.factDomainUrl');
  }
}

/** The provenance line under the source (lab's second line): which revision, or what kind of value. */
const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  phaseTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s6,
    paddingVertical: theme.space.s2,
    marginLeft: -theme.space.s6,
    borderRadius: theme.borderRadius.sm,
  },
  phase: { ...Typography.variant('body'), color: theme.colors.text.secondary },
  sourceTitle: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
    // A long unbroken name (a secret's UPPER_SNAKE name) wraps inside the column instead of clipping.
    ...(Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as const) : {}),
  },
  mono: { ...Typography.mono() },
  addFields: { gap: theme.space.s8 },
  referenceNone: { color: theme.colors.text.secondary },
  sealed: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
  },
  sealedText: { flex: 1 },
  bulk: { gap: theme.space.s12 },
  bulkFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
  },
  bulkSummary: { flex: 1, minWidth: 200 },
  // Cancel and Save stay together, at the end of the line, when the summary wraps.
  bulkActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, marginLeft: 'auto' },
  diffParts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: theme.space.s4 },
}));
