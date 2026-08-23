import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    NEW_SESSION_WIZARD_SELECTION_SECTION_IDS,
    type NewSessionWizardSectionPresentation,
    type NewSessionWizardSelectionSectionId,
} from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { t } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type WizardPresentationSectionDefinition = Readonly<{
    id: NewSessionWizardSelectionSectionId;
    titleKey:
        | 'newSession.selectAiProfileTitle'
        | 'newSession.selectAiBackendTitle'
        | 'newSession.selectModelTitle'
        | 'newSession.selectMachineTitle'
        | 'newSession.selectWorkingDirectoryTitle'
        | 'newSession.selectPermissionModeTitle';
    iconName: IconName;
}>;

const SECTION_DEFINITIONS: readonly WizardPresentationSectionDefinition[] = [
    { id: 'profiles', titleKey: 'newSession.selectAiProfileTitle', iconName: 'person' },
    { id: 'backends', titleKey: 'newSession.selectAiBackendTitle', iconName: 'cpu' },
    { id: 'models', titleKey: 'newSession.selectModelTitle', iconName: 'sparkle' },
    { id: 'machines', titleKey: 'newSession.selectMachineTitle', iconName: 'desktop' },
    { id: 'paths', titleKey: 'newSession.selectWorkingDirectoryTitle', iconName: 'folder' },
    { id: 'permissions', titleKey: 'newSession.selectPermissionModeTitle', iconName: 'shield' },
];

function isWizardPresentation(value: string): value is NewSessionWizardSectionPresentation {
    return value === 'auto' || value === 'list' || value === 'dropdown';
}

function WizardPresentationDropdown(props: Readonly<{
    section: WizardPresentationSectionDefinition;
    value: NewSessionWizardSectionPresentation;
    onChange: (value: NewSessionWizardSectionPresentation) => void;
    popoverBoundaryRef: React.RefObject<any>;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const presentationOptions: readonly DropdownMenuItem[] = [
        {
            id: 'auto',
            title: t('settingsSession.sessionCreation.wizardPresentationAutoTitle'),
            subtitle: t('settingsSession.sessionCreation.wizardPresentationAutoSubtitle'),
        },
        {
            id: 'list',
            title: t('settingsSession.sessionCreation.wizardPresentationListTitle'),
            subtitle: t('settingsSession.sessionCreation.wizardPresentationListSubtitle'),
        },
        {
            id: 'dropdown',
            title: t('settingsSession.sessionCreation.wizardPresentationDropdownTitle'),
            subtitle: t('settingsSession.sessionCreation.wizardPresentationDropdownSubtitle'),
        },
    ];
    const selectedPresentation = presentationOptions.find((option) => option.id === props.value) ?? presentationOptions[0];
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={props.value}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{
                title: t(props.section.titleKey),
                subtitle: selectedPresentation?.title,
                icon: <Icon name={props.section.iconName} size={29} color={theme.colors.text.secondary} />,
                showSelectedDetail: false,
                showSelectedSubtitle: false,
                itemProps: { testID: `settings-new-session-wizard-${props.section.id}` },
            }}
            items={presentationOptions}
            onSelect={(itemId) => {
                if (!isWizardPresentation(itemId)) return;
                props.onChange(itemId);
            }}
        />
    );
}

export const NewSessionWizardSettingsView = React.memo(function NewSessionWizardSettingsView() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);
    const [presentationBySection, setPresentationBySection] = useSettingMutable('newSessionWizardSectionPresentationV1');
    const [columnsEnabled, setColumnsEnabled] = useSettingMutable('newSessionWizardColumnsEnabled');

    const normalizedPresentationBySection = React.useMemo(() => {
        const record = presentationBySection && typeof presentationBySection === 'object' && !Array.isArray(presentationBySection)
            ? presentationBySection as Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>
            : {};
        return Object.fromEntries(
            NEW_SESSION_WIZARD_SELECTION_SECTION_IDS.flatMap((sectionId) => {
                const value = record[sectionId];
                return isWizardPresentation(value ?? '') && value !== 'auto'
                    ? [[sectionId, value]]
                    : [];
            }),
        ) as Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>;
    }, [presentationBySection]);

    const handleChange = React.useCallback((
        sectionId: NewSessionWizardSelectionSectionId,
        value: NewSessionWizardSectionPresentation,
    ) => {
        const next = { ...normalizedPresentationBySection };
        if (value === 'auto') {
            delete next[sectionId];
        } else {
            next[sectionId] = value;
        }
        setPresentationBySection(next);
    }, [normalizedPresentationBySection, setPresentationBySection]);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSession.sessionCreation.wizardLayoutTitle')}
                footer={t('settingsSession.sessionCreation.wizardLayoutFooter')}
            >
                <Item
                    testID="settings-new-session-wizard-columns"
                    title={t('settingsSession.sessionCreation.wizardColumnsTitle')}
                    subtitle={t(
                        columnsEnabled === true
                            ? 'settingsSession.sessionCreation.wizardColumnsEnabledSubtitle'
                            : 'settingsSession.sessionCreation.wizardColumnsDisabledSubtitle',
                    )}
                    icon={<Icon name="grid-four" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={columnsEnabled === true}
                            onValueChange={(next) => setColumnsEnabled(Boolean(next))}
                        />
                    )}
                    showChevron={false}
                    onPress={() => setColumnsEnabled(columnsEnabled !== true)}
                />
            </ItemGroup>
            <ItemGroup
                title={t('settingsSession.sessionCreation.wizardPresentationTitle')}
                footer={t('settingsSession.sessionCreation.wizardPresentationFooter')}
            >
                {SECTION_DEFINITIONS.map((section) => (
                    <WizardPresentationDropdown
                        key={section.id}
                        section={section}
                        value={normalizedPresentationBySection[section.id] ?? 'auto'}
                        onChange={(value) => handleChange(section.id, value)}
                        popoverBoundaryRef={popoverBoundaryRef}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});

export default NewSessionWizardSettingsView;
