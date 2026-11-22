import * as React from 'react';

import { Icon } from '@/components/ui/icons/Icon';
import type {
  SelectionListOption,
  SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { t } from '@/text';

/** The checkout's own Machine row: what "This machine" means for this picker. */
export type WorkerDestinationPrimaryRow = Readonly<{
  title: string;
  subtitle?: string;
}>;

const SERVICE_SECTION_TITLES = { all: null } as const;

/**
 * The Machine section titles the Project work list asks the shared list model for. The model alone
 * groups and names rows (your own, then "Shared with you · <owner>"); this only names your own bucket:
 * "Workers", or untitled in the service anatomy (32s1, lab PICK).
 */
export function workerDestinationSectionTitles(servicePresentation: boolean) {
  return servicePresentation
    ? SERVICE_SECTION_TITLES
    : { all: t('projectWorkers.workersSection') };
}

export type WorkerDestinationSectionsInput = Readonly<{
  /** The shared list model's sections, already grouped by ownership. */
  sections: ReadonlyArray<SelectionListSectionDescriptor>;
  title: string;
  testID: string;
  phone: boolean;
  iconColor: string;
  primary?: WorkerDestinationPrimaryRow | null;
  onChoosePrimary: () => void;
  exactTargetOnly?: boolean;
  presentPoolAsAutomatic?: boolean;
  servicePresentation?: boolean;
  trailingSections?: ReadonlyArray<SelectionListSectionDescriptor>;
}>;

/**
 * Where Project work runs: the primary checkout first, then the model's Machine sections unchanged
 * (their grouping and titles belong to the list model), then pools. Shared by the picker and its
 * `/dev` specimen so the two cannot draw different groupings.
 */
export function shapeWorkerDestinationSections(
  input: WorkerDestinationSectionsInput,
): SelectionListSectionDescriptor[] {
  const { sections } = input;
  const isPoolSection = (section: SelectionListSectionDescriptor) =>
    section.id === 'machine-pools' || section.id.endsWith(':machine-pools');
  const poolOptions = sections
    .filter(isPoolSection)
    .flatMap((section) => (section.kind === 'static' ? section.options : []))
    .filter((option) => option.id.startsWith('pool:'));
  const lonePool =
    !input.exactTargetOnly &&
    input.presentPoolAsAutomatic &&
    poolOptions.length === 1
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
            icon: <Icon name="stack" size={18} color={input.iconColor} />,
          } as SelectionListOption,
        ]
      : []),
    ...(input.primary
      ? [
          {
            id: 'primary',
            testID: `${input.testID}-option:primary`,
            label: input.primary.title,
            ...(input.primary.subtitle
              ? { subtitle: input.primary.subtitle }
              : {}),
            icon: <Icon name="hard-drives" size={18} color={input.iconColor} />,
            onSelect: input.onChoosePrimary,
          } satisfies SelectionListOption,
        ]
      : []),
  ];
  const poolSections =
    input.exactTargetOnly || lonePool
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
                            ...(input.servicePresentation
                              ? {
                                  label: t('projectServices.anyWorker'),
                                  subtitle: t(
                                    'projectServices.anyWorkerDetail',
                                    { pool: option.label },
                                  ),
                                }
                              : {}),
                            icon: (
                              <Icon
                                name="stack"
                                size={18}
                                color={input.iconColor}
                              />
                            ),
                          } as SelectionListOption)
                        : option,
                    ),
                  }
                : {}),
              title: input.servicePresentation
                ? undefined
                : t('projectWorkers.poolsSection'),
            }) as SelectionListSectionDescriptor,
        );
  return [
    ...(leading.length > 0
      ? [
          {
            kind: 'static',
            id: 'run-on-leading',
            // The phone sheet already titles itself with this text; a desktop popover has no header.
            title:
              input.servicePresentation || input.phone
                ? undefined
                : input.title,
            options: leading,
          } as const,
        ]
      : []),
    ...sections.filter((section) => !isPoolSection(section)),
    ...poolSections,
    ...(input.trailingSections ?? []),
  ];
}
