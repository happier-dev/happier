import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { SecretKeyBackupModal } from '@/components/account/SecretKeyBackupModal';
import { useRecoveryKeyReminder } from '@/components/account/useRecoveryKeyReminder';
import { HomePairingPanel } from '@/components/auth/pairing/HomePairingPanel';
import { useHomesJourneySetupItems } from '@/components/homes/journeys/useHomesJourneySetupItems';
import { useConnectServicesSetupItem } from '@/components/settings/connectedServices/home/useConnectServicesSetupItem';
import { useFirstAgentSetupItem } from '@/components/machines/agents/useFirstAgentSetupItem';
import { useVoiceSetupBlock } from '@/voice/settings/setup/VoiceSetupItem';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { usePluginAdministrationSummary } from '@/components/settings/plugins/model/pluginAdministrationSummary';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { useScannedAuthUrlProcessor } from '@/hooks/auth/useScannedAuthUrlProcessor';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { Modal } from '@/modal';
import { useAllMachines, useIsActiveMachineListSettled } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type { HubSectionProps } from './hubSectionProps';
import { useHomeSetupDismissals } from './layout/useHomeSetupDismissals';
import { homeHasMachine } from '@/components/machines/add/machineAddPaths';
import { AddMachinePanel } from './setup/AddMachinePanel';
import { useSetupDevice } from './setup/useSetupDevice';
import { usePersonalizeSetupItem } from '@/components/onboarding/personalize/usePersonalizeSetupItem';
import { useAskHappierSetupItem } from '@/components/sessions/bots/useAskHappierSetupItem';
import { ConnectComputerPanel } from './setup/ConnectComputerPanel';
import { SetupBlockGrid, type SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';

/** What a button does. */
type SetupActionId = 'recoveryKey' | 'addMachine' | 'showAddPhonePage' | 'scanTerminal' | 'enterTerminalUrl' | 'browsePlugins';

/**
 * One "Get set up" item. The id is also the step id a dismissal stores on the Account layout
 * (`setup:<id>`), so it must stay stable.
 */
type SetupEntryId = 'recoveryKey' | 'addPhone' | 'addMachine' | 'connectComputer' | 'browsePlugins';

type SetupEntryAction = Readonly<{ id: SetupActionId; label: string; testID: string }>;

/** What an entry grows into on Home, in place of its action there. */
type SetupEntryPanel = 'pairPhone' | 'scanComputer' | 'addMachine';

/** One thing to set up: one row (or tile), counted once, with its action and at most one alternative. */
type SetupEntry = Readonly<{
    id: SetupEntryId;
    testID: string;
    icon: IconName;
    title: string;
    subtitle: string;
    /** What pressing its button does in the Settings checklist (and on Home when it has no panel). */
    action: SetupEntryAction;
    /** Another way to complete the same step, as a second button on the row ("Paste link"). */
    alternative?: SetupEntryAction;
    /** On Home, the button grows the tile into this panel instead (the setup becomes the setup itself). */
    panel?: SetupEntryPanel;
    /** `step`: it has a done state this device can see and counts toward progress. `action`: it never does. */
    kind: 'step' | 'action';
    disabled?: boolean;
}>;

type SetupStep = Readonly<{ id: SetupEntryId; done: boolean }>;
type SetupPresentation = 'tiles' | 'checklist';

const TERMINAL_AUTH_URL_PROCESSOR_OPTIONS = { allowedUrlKind: 'terminal' } as const;
const PROGRESS_METER_WIDTH = 72;

/**
 * What is left to set up. Steps are the things whose completion this device can truthfully see —
 * a first machine (once the Home's machine list is known) and the recovery key (saved or dismissed
 * counts as done), plus Add your phone once its launched pairing flow succeeds or is dismissed.
 * Each disappears once done. Connecting a computer and browsing plugins remain actions.
 *
 * `tiles` (Home) shows, on a computer, Add your phone · Add a machine;
 * on a phone, Connect a computer · Add a machine (lab I1/I1p). Every tile has a dismiss that the
 * Account layout keeps (Customize → Hidden setup steps brings them back), and the section leaves
 * when nothing is left. `checklist` (the Settings Overview) lists the steps and the ways to connect a
 * device as rows under a meter counting the done steps out of those plus the rows this device shows.
 */
export const HubSetupSection = React.memo(function HubSetupSection(props: HubSectionProps & Readonly<{
    presentation?: SetupPresentation;
}>) {
    return props.presentation === 'checklist'
        ? <HubSetupChecklist menu={props.menu} />
        : <HubSetupTiles menu={props.menu} />;
});

/** The entries this device shows, from the canonical owners of each step's truth. */
function useSetupEntries(presentation: SetupPresentation) {
    const router = useRouter();
    const auth = useAuth();
    const { hidden, dismiss } = useHomeSetupDismissals();
    const { isComputer, isPhone, tileLayout } = useSetupDevice();
    const { connectTerminal, isLoading: isConnectingTerminal } = useConnectTerminal();
    const { processAuthUrl } = useScannedAuthUrlProcessor(TERMINAL_AUTH_URL_PROCESSOR_OPTIONS);
    // Only a machine known to have no installed plugins is an invitation; unknown shows nothing.
    const plugins = usePluginAdministrationSummary();
    const suggestPlugins = plugins.known && plugins.userInstalled === 0;
    const recoveryKey = useRecoveryKeyReminder({ surface: 'hubTile' });
    // "The Home has a machine" is the add-machine owner's one rule (revoked machines don't count).
    const hasMachine = homeHasMachine(useAllMachines()) === true;
    const machineListSettled = useIsActiveMachineListSettled();
    const tiles = presentation === 'tiles';

    const steps: SetupStep[] = [
        ...(isComputer && auth.isAuthenticated ? [{ id: 'addPhone' as const, done: hidden.has('addPhone') }] : []),
        ...(machineListSettled ? [{ id: 'addMachine' as const, done: hasMachine }] : []),
        ...(recoveryKey.step !== null ? [{ id: 'recoveryKey' as const, done: recoveryKey.step === 'done' }] : []),
    ];
    const open = new Set(steps.filter((step) => !step.done).map((step) => step.id));

    // The first-machine step leaves both surfaces once the canonical machine list confirms it.
    // Home keeps the affordance while that list is still unknown, without claiming completion.
    const addMachine: SetupEntry | null = (tiles && !machineListSettled) || open.has('addMachine') ? {
        id: 'addMachine',
        testID: 'hub-setup.addMachine',
        icon: 'hard-drives',
        title: t('settingsOverview.addMachineTitle'),
        subtitle: !tiles
            ? t('settingsOverview.addMachineSubtitle')
            : isPhone ? t('homeSetup.phoneAddMachineSubtitle') : t('homeSetup.addMachineSubtitle'),
        action: {
            id: 'addMachine',
            label: tiles && isPhone ? t('homeSetup.phoneAddMachineAction') : t('settingsOverview.setupActionAddMachine'),
            testID: 'hub-setup.addMachine.action',
        },
        // On Home the ways to add a machine open in place; the checklist leads to their page.
        ...(tiles ? { panel: 'addMachine' as const } : {}),
        kind: open.has('addMachine') ? 'step' : 'action',
    } : null;

    const entries: SetupEntry[] = [
        ...(open.has('recoveryKey') ? [{
            id: 'recoveryKey' as const,
            testID: 'hub-setup.recoveryKey',
            icon: 'key' as const,
            title: t('settingsOverview.saveRecoveryKeyTitle'),
            subtitle: t('settingsOverview.saveRecoveryKeySubtitle'),
            action: { id: 'recoveryKey' as const, label: t('settingsOverview.setupActionSaveKey'), testID: 'hub-setup.recoveryKey.action' },
            kind: 'step' as const,
        }] : []),
        ...(open.has('addPhone') ? [{
            id: 'addPhone' as const,
            testID: 'settings-add-your-phone-shortcut',
            icon: 'device-mobile' as const,
            title: t('settings.addYourPhone'),
            subtitle: tiles ? t('homeSetup.addPhoneSubtitle') : t('settings.addYourPhoneSubtitle'),
            action: {
                id: 'showAddPhonePage' as const,
                label: tiles ? t('homeSetup.addPhoneAction') : t('settingsOverview.setupActionShowQr'),
                testID: 'settings-add-your-phone-shortcut.action',
            },
            panel: 'pairPhone' as const,
            kind: 'step' as const,
        }] : []),
        // Connecting a computer from a phone is one step with two ways to do it: scan the code its
        // terminal shows, or paste its link. On Home the scan opens the camera in place.
        ...(isPhone ? [{
            id: 'connectComputer' as const,
            testID: 'hub-setup.connectComputer',
            icon: 'laptop' as const,
            title: t('homeSetup.connectComputerTitle'),
            subtitle: isConnectingTerminal ? t('common.scanning') : t('homeSetup.connectComputerSubtitle'),
            action: {
                id: 'scanTerminal' as const,
                label: t('settingsOverview.setupActionScan'),
                testID: tiles ? 'hub-setup.connectComputer.action' : 'settings-connect-terminal-scan',
            },
            ...(tiles ? { panel: 'scanComputer' as const } : {
                alternative: { id: 'enterTerminalUrl' as const, label: t('settingsOverview.setupActionPasteLink'), testID: 'settings-connect-terminal-enter-url' },
            }),
            kind: 'action' as const,
            disabled: isConnectingTerminal,
        }] : []),
        ...(addMachine ? [addMachine] : []),
        ...(suggestPlugins ? [{
            id: 'browsePlugins' as const,
            testID: 'settings-overview-browse-plugins',
            icon: 'squares-four' as const,
            title: t('settingsOverview.browsePluginsTitle'),
            subtitle: t('settingsOverview.browsePluginsSubtitle'),
            action: { id: 'browsePlugins' as const, label: t('settingsOverview.setupActionBrowse'), testID: 'settings-overview-browse-plugins.action' },
            kind: 'action' as const,
        }] : []),
    ];

    const runAction = React.useCallback(async (id: SetupActionId) => {
        if (id === 'recoveryKey') {
            if (!recoveryKey.secret) return;
            Modal.show({
                component: SecretKeyBackupModal,
                props: { secret: recoveryKey.secret, onSaved: recoveryKey.markSaved },
            });
            return;
        }
        if (id === 'addMachine') {
            router.push(SETTINGS_ROUTES.machinesAdd as never);
            return;
        }
        if (id === 'showAddPhonePage') {
            router.push('/settings/add-phone?setupStep=addPhone');
            return;
        }
        if (id === 'browsePlugins') {
            router.push('/settings/plugins');
            return;
        }
        if (id === 'scanTerminal') {
            await connectTerminal();
            return;
        }
        const url = await Modal.prompt(
            t('modals.authenticateTerminal'),
            t('modals.pasteUrlFromTerminal'),
            {
                placeholder: t('connect.terminalUrlPlaceholder'),
                confirmText: t('common.authenticate'),
            },
        );
        if (url?.trim()) {
            await processAuthUrl(url.trim());
        }
    }, [connectTerminal, processAuthUrl, recoveryKey.markSaved, recoveryKey.secret, router]);

    return { entries, steps, open, runAction, tileLayout, hidden, dismiss };
}

/** Home's Get set up: tiles on a computer, rows on a phone; each grows in place when it can. */
function HubSetupTiles(props: HubSectionProps) {
    const { entries, runAction, tileLayout, hidden, dismiss } = useSetupEntries('tiles');
    const phone = tileLayout === 'row';
    // The Homes journeys' steps lead the row (lab order: J6 laptop nudge, J2 reconcile, K1 "Already
    // use Happier?"); they share this row's morph and its dismissed-steps store.
    const journeyItems = useHomesJourneySetupItems({ onDismiss: dismiss, layout: tileLayout });
    // Connecting Claude or ChatGPT (lab csvc H2): the connected-services owner decides what is offered
    // and grows its setup panel through this row; it is null when nothing is left to offer.
    const servicesItem = useConnectServicesSetupItem({ layout: tileLayout });
    // A composer machine with no agent yet (lab agent-setup H1): the agents owner decides; it leads the row.
    const firstAgentItem = useFirstAgentSetupItem({ phone });
    // "Set up voice" (lab voice-moments SA): the Voice setup owner decides; null once Voice is set up.
    const voiceItem = useVoiceSetupBlock({ layout: tileLayout });
    // "Personalize Happier" (lab personalize H1): after the steps that connect real work on a
    // computer, first on a phone where there are fewer of them. Its owner decides; null once done.
    const personalizeItem = usePersonalizeSetupItem({ hidden, onDismiss: dismiss });
    // "Ask Happier" (lab b-rail G, D33): an opt-in guide that sets the rest up with the person.
    const askHappierItem = useAskHappierSetupItem({ layout: tileLayout });
    const visible = entries.filter((entry) => !hidden.has(entry.id));

    const items: SetupBlockItem[] = visible.map((entry) => ({
        id: entry.id,
        renderTile: ({ open }) => (
            <SetupBlockTile
                testID={entry.testID}
                layout={tileLayout}
                icon={entry.icon}
                title={entry.title}
                subtitle={entry.subtitle}
                disabled={entry.disabled}
                action={{
                    label: entry.action.label,
                    testID: entry.action.testID,
                    onPress: entry.panel ? open : () => { void runAction(entry.action.id); },
                }}
                dismiss={{
                    label: t('homeSetup.dismiss', { title: entry.title }),
                    tooltip: t('homeSetup.dismissTooltip'),
                    onPress: () => dismiss(entry.id),
                }}
            />
        ),
        ...(entry.panel ? { renderPanel: ({ close }: Readonly<{ close: () => void }>) => renderSetupPanel(entry.panel!, close, () => dismiss('addPhone')) } : {}),
    }));

    const allItems = [
        ...(personalizeItem && phone ? [personalizeItem] : []),
        ...(firstAgentItem ? [firstAgentItem] : []),
        ...journeyItems.filter((item) => !hidden.has(item.id)),
        ...(voiceItem ? [voiceItem] : []),
        ...items,
        ...(personalizeItem && !phone ? [personalizeItem] : []),
        ...(servicesItem ? [servicesItem] : []),
        ...(askHappierItem ? [askHappierItem] : []),
    ];
    if (allItems.length === 0) return null;
    return <HubSetupGridView items={allItems} phone={phone} menu={props.menu} />;
}

/** "Get set up" as drawn: the title, ⋯, and the set-up blocks (the `/dev/home` fixture draws it too). */
export function HubSetupGridView(props: Readonly<{
    items: readonly SetupBlockItem[];
    phone: boolean;
    menu?: React.ReactNode;
    /** Dev fixtures only: a block drawn already open (the live Home lets the grid own opening). */
    openId?: string | null;
}>) {
    return (
        <ItemGroup title={t('settingsOverview.setupTitle')} surface="none" action={props.menu}>
            <SetupBlockGrid testID="hub-setup.grid" items={props.items} columns={props.phone ? 1 : 3} openId={props.openId} />
        </ItemGroup>
    );
}

function renderSetupPanel(panel: SetupEntryPanel, close: () => void, onPhoneCompleted: () => void): React.ReactNode {
    if (panel === 'scanComputer') return <ConnectComputerPanel testIDPrefix="hub-setup.connect-computer" close={close} />;
    if (panel === 'addMachine') return <AddMachinePanel testIDPrefix="hub-setup.add-machine" close={close} />;
    return (
        <HomePairingPanel
            purpose="phone"
            layout="inline"
            testIDPrefix="hub-setup.pairing"
            onClose={close}
            onCompleted={onPhoneCompleted}
        />
    );
}

/** The Settings Overview checklist: rows with their action under the progress meter. */
function HubSetupChecklist(props: HubSectionProps) {
    const { entries, steps, open, runAction } = useSetupEntries('checklist');
    if (entries.length === 0) return null;
    // The meter counts what this device's list is made of: the steps already done (their rows
    // have left) plus every row it shows, so "1 of 3" always matches the rows on screen.
    const done = steps.length - open.size;
    return (
        <ItemGroup
            title={t('settingsOverview.setupTitle')}
            action={(
                <View style={stylesheet.headerActions}>
                    <SetupProgress done={done} total={done + entries.length} />
                    {props.menu}
                </View>
            )}
        >
            {entries.map((entry) => (
                <SetupRow key={entry.id} entry={entry} onAction={runAction} />
            ))}
        </ItemGroup>
    );
}

/** "1 of 2" with a short meter: how many of the visible steps are done. */
function SetupProgress(props: Readonly<{ done: number; total: number }>) {
    const label = t('settingsOverview.setupProgress', { done: props.done, total: props.total });
    return (
        <View testID="hub-setup.progress" style={stylesheet.progress}>
            <MeterBar
                style={stylesheet.progressMeter}
                tone="neutral"
                fillFraction={props.total > 0 ? props.done / props.total : 0}
                progressAccessibilityLabel={t('settingsOverview.setupTitle')}
            />
            <Text style={stylesheet.progressLabel}>{label}</Text>
        </View>
    );
}

/**
 * One open step (an empty check mark) or action (its glyph). The whole row takes the action, and its
 * button names it; the button is its own control beside the row rather than nested in it.
 */
function SetupRow(props: Readonly<{ entry: SetupEntry; onAction: (id: SetupActionId) => Promise<void> }>) {
    const { theme } = useUnistyles();
    const { entry, onAction } = props;
    const act = React.useCallback(() => { void onAction(entry.action.id); }, [entry.action.id, onAction]);
    const alternative = entry.alternative;
    return (
        <Item
            testID={entry.testID}
            title={entry.title}
            subtitle={entry.subtitle}
            // The description is a sentence: it wraps on a phone rather than being cut.
            subtitleLines={0}
            // A step not done yet reads as an empty check mark; an action shows its glyph. Both sit in
            // the rows' leading column so the titles line up.
            icon={entry.kind === 'step'
                ? <Icon name="circle" color={theme.colors.text.tertiary} />
                : <Icon name={entry.icon} color={theme.colors.text.secondary} />}
            showChevron={false}
            disabled={entry.disabled}
            onPress={act}
            rightElementOutsidePressable
            // Two buttons are wider than a phone row can spare beside the label: they move beneath it
            // there (phones recompose rather than cut the title).
            accessoryLayout="adaptive"
            rightElement={(
                <View style={stylesheet.rowActions}>
                    {alternative ? (
                        <RoundButton
                            testID={alternative.testID}
                            size="small"
                            display="secondary"
                            title={alternative.label}
                            disabled={entry.disabled}
                            onPress={() => { void onAction(alternative.id); }}
                        />
                    ) : null}
                    <RoundButton
                        testID={entry.action.testID}
                        size="small"
                        display="secondary"
                        title={entry.action.label}
                        disabled={entry.disabled}
                        onPress={act}
                    />
                </View>
            )}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    rowActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    progress: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    progressMeter: {
        width: PROGRESS_METER_WIDTH,
    },
    progressLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        fontVariant: ['tabular-nums'],
    },
}));
