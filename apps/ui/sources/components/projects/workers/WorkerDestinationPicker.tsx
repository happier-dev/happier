import * as React from 'react';
import type { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import type {
  ProjectExecutionChoiceV1,
  WorkspaceExecutionConfigAddressV1,
} from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import { useMachineSelectionListModel } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { useMachinePoolGroups } from '@/components/sessions/new/hooks/machines/useMachinePoolGroups';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import { Icon } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import {
  SELECTION_LIST_LARGE_POPOVER_SIZE,
  SelectionList,
  type SelectionListOption,
  type SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { useAllMachines } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** The checkout's own Machine row: what "This machine" means for this picker. */
export type WorkerDestinationPrimaryRow = Readonly<{
  title: string;
  subtitle?: string;
}>;

export type WorkerDestinationPickerProps = Readonly<{
  testID: string;
  open: boolean;
  onRequestClose: () => void;
  anchorRef: React.RefObject<View | null>;
  /** The picker's question ("Run test on", "Runs on"); also the phone sheet's name. */
  title: string;
  purpose: 'finite' | 'service-start';
  workspace: WorkspaceExecutionConfigAddressV1;
  /** The checkout's own Machine. It is the primary choice, never a worker row. */
  sourceMachineId: string | null;
  subjectName?: string;
  memoryDemand?: ProjectMemoryDemandV1;
  /** Offer the primary checkout ("This machine"); omit where only a worker destination is meaningful. */
  primary?: WorkerDestinationPrimaryRow | null;
  /** How a chosen pool picks its member: the run's own choice is automatic; a saved default may ask. */
  poolSelection: 'automatic' | 'ask';
  /** Present a lone pool as the automatic choice ("Choose automatically · Build pool"). */
  presentPoolAsAutomatic?: boolean;
  /** Service anatomy (32s1, lab PICK): untitled rows, each pool named "Any worker" that picks when the service starts. */
  servicePresentation?: boolean;
  selected: ProjectExecutionChoiceV1 | null;
  onChoose: (choice: ProjectExecutionChoiceV1) => void;
  /** Trailing rows owned by the consumer (Worker settings…); rendered after the destinations. */
  trailingSections?: ReadonlyArray<SelectionListSectionDescriptor>;
  footer?: React.ReactNode;
}>;

function selectedOptionId(
  selected: ProjectExecutionChoiceV1 | null,
  serverId: string,
): string | null {
  if (!selected) return null;
  if (selected.kind === 'primary') return 'primary';
  return selected.destination.kind === 'machine'
    ? selected.destination.machineId
    : `pool:${serverId}:${selected.destination.poolId}`;
}

/**
 * Where Project work runs (30s2/30s3, 32s1): the incumbent purpose-qualified destination list
 * (`useMachineSelectionListModel` with exact worker status), presented as an anchored menu on wide
 * screens and a sheet on phones. Choosing records a choice only; it never runs, wakes or allocates.
 * This composes the canonical list; it decides no eligibility or ranking of its own.
 */
export function WorkerDestinationPicker(props: WorkerDestinationPickerProps) {
  return props.open ? <OpenWorkerDestinationPicker {...props} /> : null;
}

/** Mounted only while open, so a closed trigger issues no Machine status demand. */
function OpenWorkerDestinationPicker(props: WorkerDestinationPickerProps) {
  const { theme } = useUnistyles();
  const serverId = props.workspace.serverId;
  const activeServer = useNewSessionActiveServerSource();
  const allMachines = useAllMachines();
  const serverIds = React.useMemo(() => [serverId], [serverId]);
  const scopedGroups = useServerScopedMachineOptions({
    allowedServerIds: serverIds,
    activeServerId: activeServer.activeServerId,
    activeMachines: allMachines,
  });
  // The checkout's own Machine is the primary choice, not a worker destination.
  const groups = React.useMemo(
    () =>
      scopedGroups.map((group) => ({
        ...group,
        machines: group.machines.filter(
          (machine) => machine.id !== props.sourceMachineId,
        ),
      })),
    [props.sourceMachineId, scopedGroups],
  );
  const poolGroups = useMachinePoolGroups(groups);
  const onChooseRef = React.useRef(props.onChoose);
  onChooseRef.current = props.onChoose;
  const poolSelection = props.poolSelection;
  const workerPlacement = React.useMemo(
    () => ({
      workspace: props.workspace,
      ...(props.memoryDemand ? { memoryDemand: props.memoryDemand } : {}),
    }),
    [props.memoryDemand, props.workspace],
  );
  const workerSubject = React.useMemo(
    () => ({
      ...(props.subjectName ? { scriptName: props.subjectName } : {}),
      ...(props.memoryDemand
        ? { memoryDemandBytes: props.memoryDemand.bytes }
        : {}),
    }),
    [props.memoryDemand, props.subjectName],
  );
  const sectionTitles = React.useMemo(
    () => ({ all: t('projectWorkers.workersSection') }),
    [],
  );

  const list = useMachineSelectionListModel({
    purpose: props.purpose,
    workerPlacement,
    workerSubject,
    groups,
    poolGroups,
    selectedMachine: null,
    selectedServerId: serverId,
    recentMachines: [],
    favoriteMachines: [],
    // One-Home lists activate rows through onSelectMachine; several Homes through the scoped one.
    onSelectMachine: (machine) =>
      onChooseRef.current({
        kind: 'workers',
        destination: { kind: 'machine', machineId: machine.id },
      }),
    onSelectScopedMachine: (machine) =>
      onChooseRef.current({
        kind: 'workers',
        destination: { kind: 'machine', machineId: machine.id },
      }),
    onSelectPool: (selection) =>
      onChooseRef.current({
        kind: 'workers',
        destination: {
          kind: 'pool',
          poolId: selection.pool.pool.id,
          selection: poolSelection,
        },
      }),
    serverId,
    showFavorites: false,
    showRecent: false,
    showSearch: false,
    showCliGlyphs: false,
    autoDetectCliGlyphs: false,
    sectionTitles,
    testIdPrefix: props.testID,
  });

  const rootStep = React.useMemo(() => {
    const sections = list.rootStep.sections;
    const isPoolSection = (section: SelectionListSectionDescriptor) =>
      section.id === 'machine-pools' || section.id.endsWith(':machine-pools');
    const poolOptions = sections
      .filter(isPoolSection)
      .flatMap((section) => (section.kind === 'static' ? section.options : []))
      .filter((option) => option.id.startsWith('pool:'));
    const lonePool =
      props.presentPoolAsAutomatic && poolOptions.length === 1
        ? poolOptions[0]!
        : null;
    const leading: SelectionListOption[] = [
      ...(lonePool
        ? [
            {
              ...lonePool,
              label: t('projectWorkers.automatic'),
              subtitle: [lonePool.label, lonePool.subtitle]
                .filter(Boolean)
                .join(' · '),
              icon: (
                <Icon
                  name="stack"
                  size={18}
                  color={theme.colors.text.secondary}
                />
              ),
            } as SelectionListOption,
          ]
        : []),
      ...(props.primary
        ? [
            {
              id: 'primary',
              testID: `${props.testID}-option:primary`,
              label: props.primary.title,
              ...(props.primary.subtitle
                ? { subtitle: props.primary.subtitle }
                : {}),
              icon: (
                <Icon
                  name="hard-drives"
                  size={18}
                  color={theme.colors.text.secondary}
                />
              ),
              onSelect: () => onChooseRef.current({ kind: 'primary' }),
            } satisfies SelectionListOption,
          ]
        : []),
    ];
    const poolSections = lonePool
      ? []
      : sections.filter(isPoolSection).map(
          (section) =>
            ({
              ...section,
              ...(section.kind === 'static'
                ? {
                    options: section.options.map((option) =>
                      option.id.startsWith('pool:')
                        ? ({
                            ...option,
                            ...(props.servicePresentation
                              ? {
                                  label: t('projectServices.anyWorker'),
                                  subtitle: t('projectServices.anyWorkerDetail', { pool: option.label }),
                                }
                              : {}),
                            icon: (
                              <Icon
                                name="stack"
                                size={18}
                                color={theme.colors.text.secondary}
                              />
                            ),
                          } as SelectionListOption)
                        : option,
                    ),
                  }
                : {}),
              title: props.servicePresentation ? undefined : t('projectWorkers.poolsSection'),
            }) as SelectionListSectionDescriptor,
        );
    const machineSections = sections
      .filter((section) => !isPoolSection(section))
      .map(
        (section) =>
          ({
            ...section,
            title: props.servicePresentation ? undefined : t('projectWorkers.workersSection'),
          }) as SelectionListSectionDescriptor,
      );
    const ordered: SelectionListSectionDescriptor[] = [
      ...(leading.length > 0
        ? [
            {
              kind: 'static',
              id: 'run-on-leading',
              title: props.servicePresentation ? undefined : props.title,
              options: leading,
            } as const,
          ]
        : []),
      ...machineSections,
      ...poolSections,
      ...(props.trailingSections ?? []),
    ];
    return {
      ...list.rootStep,
      sections: ordered,
      emptyStateLabel: t('projectWorkers.empty'),
    };
  }, [
    list.rootStep,
    props.presentPoolAsAutomatic,
    props.servicePresentation,
    props.primary,
    props.testID,
    props.title,
    props.trailingSections,
    theme.colors.text.secondary,
  ]);

  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      placement="bottom"
      gap={6}
      maxHeightCap={SELECTION_LIST_LARGE_POPOVER_SIZE.maxHeightCap}
      maxWidthCap={420}
      portal={{
        ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
        anchorAlign: 'end',
      }}
      phonePresentation="sheet"
      accessibilityLabel={props.title}
      containerStyle={{ paddingHorizontal: 0 }}
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight }) => (
        <FloatingOverlay
          maxHeight={maxHeight}
          surfaceChrome="theme"
          scrollEnabled={false}
        >
          <SelectionList
            testID={props.testID}
            rootStep={rootStep}
            selectedOptionId={selectedOptionId(props.selected, serverId)}
            onSelect={() => props.onRequestClose()}
            onRequestClose={props.onRequestClose}
            listAccessibilityLabel={props.title}
            maxHeight={maxHeight}
            bodyFooter={props.footer}
            disableTransitions
          />
        </FloatingOverlay>
      )}
    </Popover>
  );
}
