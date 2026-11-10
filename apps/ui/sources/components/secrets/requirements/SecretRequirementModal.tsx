import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { useMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { shadowLevelStyle } from '@/shadowElevation';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useScrollViewWheelScrollTo } from '@/components/ui/scroll/useScrollViewWheelScrollTo';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';


const secretRequirementSelectionMemory = new Map<string, 'machine' | 'saved' | 'once'>();

export type SecretRequirementModalResult =
    | { action: 'cancel' }
    | { action: 'useMachine'; envVarName: string }
    | { action: 'selectSaved'; envVarName: string; secretId: string; setDefault: boolean }
    | { action: 'enterOnce'; envVarName: string; value: string };

export type SecretRequirementModalVariant = 'requirement' | 'defaultForProfile';

export type SecretRequirementModalProps = CustomModalInjectedProps & Readonly<{
    profile: Pick<AiLaunchProfile, 'id' | 'name'>;
    /**
     * The specific secret environment variable name this modal is resolving (e.g. OPENAI_API_KEY).
     * The caller owns its `envVarRequirements[]` admission with `kind='secret'`.
     */
    secretEnvVarName: string;
    /**
     * Optional: allow resolving multiple secret env vars within the same modal.
     * When provided (and when `variant="requirement"`), the user can switch which secret
     * they're resolving via a dropdown.
     */
    secretEnvVarNames?: ReadonlyArray<string>;
    machineId: string | null;
    defaultSecretId: string | null;
    selectedSavedSecretId?: string | null;
    /**
     * Optional per-env state (used to preselect and persist across reopens).
     * These are keyed by env var name (UPPERCASE).
     */
    selectedSecretIdByEnvVarName?: Readonly<Record<string, string | null | undefined>> | null;
    sessionOnlySecretValueByEnvVarName?: Readonly<Record<string, string | null | undefined>> | null;
    defaultSecretIdByEnvVarName?: Readonly<Record<string, string | null | undefined>> | null;
    /**
     * When provided, toggling "default" updates the default without selecting a key for the current flow.
     * (Lets the user keep the modal open and still pick a different key for just this session.)
     */
    onSetDefaultSecretId?: (id: string | null) => void;
    /**
     * Controls presentation. `defaultForProfile` is a simplified view that only lets the user choose
     * a saved key as the profile default.
     */
    variant?: SecretRequirementModalVariant;
    titleOverride?: string;
    /**
     * The surface lets the person add a personal key while choosing (through the Saved Secret catalog).
     * Renaming, replacing and deleting stay on the Secrets settings page, which the prompt links to.
     */
    allowManage?: boolean;
    onResolve: (result: SecretRequirementModalResult) => void;
    allowSessionOnly?: boolean;
    /** Exact Home feature decision; false keeps personal choices but never observes shared rows. */
    sharedSavedSecretsEnabled?: boolean;
    /** Exact Account/Home for mounted cross-Home launchers. */
    accountScope?: AccountSettingsScope | null;
    /**
     * Layout variant:
     * - `modal` (default): centered, content-sized card (web + legacy overlays)
     * - `screen`: full-width/full-height screen content (native route screens)
     */
    layoutVariant?: 'modal' | 'screen';
}>;

export function SecretRequirementModal(props: SecretRequirementModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const savedSecretCatalog = useSavedSecretCatalog({
        sharedEnabled: props.sharedSavedSecretsEnabled !== false,
        ...(Object.prototype.hasOwnProperty.call(props, 'accountScope') ? { scope: props.accountScope ?? null } : {}),
    });
    const canManage = props.allowManage === true && savedSecretCatalog.personalMutationsAvailable;
    const router = useRouter();
    // The prompt chooses; managing saved secrets is the Secrets page's job, so it leads there.
    const openSecretsSettings = React.useCallback(() => {
        props.onResolve({ action: 'cancel' });
        props.onClose();
        router.push('/settings/secrets');
    }, [props.onClose, props.onResolve, router]);

    const layoutVariant: 'modal' | 'screen' = props.layoutVariant ?? 'modal';
    const useCardChrome = layoutVariant === 'modal';
    // IMPORTANT:
    // The secret requirement modal can be intentionally small (content-sized). If we use the modal's
    // internal scroll container as the Popover boundary, dropdown menus get their maxHeight clipped
    // to the modal instead of the screen. Explicitly disable boundary clamping so Popover falls back
    // to the full window bounds while still anchoring to the trigger.

    const modalTitle = props.titleOverride ?? t('profiles.requirements.modalTitle');
    const modalSubtitle = props.profile?.name ?? '';
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: modalTitle,
        subtitle: modalSubtitle,
        testID: 'secret-requirement:modal',
        closeButtonTestID: 'secret-requirement:close',
        // A pick list: the card takes its full bound and keeps it while a search narrows the list;
        // the prompt's own scroller moves the rows inside it.
        scrollHost: 'body' as const,
        dimensions: {
            width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
            maxHeightRatio: 0.92,
            size: 'lg' as const,
        },
    }), [modalSubtitle, modalTitle]);

    useModalCardChrome(props.setChrome, useCardChrome ? chrome : null);

    const fades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const scrollRef = React.useRef<ScrollView>(null);
    const wheelScrollHandlers = useScrollViewWheelScrollTo(scrollRef, {
        onScroll: fades.onScroll,
    });

    const normalizedSecretEnvVarName = React.useMemo(() => props.secretEnvVarName.trim().toUpperCase(), [props.secretEnvVarName]);
    const secretEnvVarNames = React.useMemo(() => {
        const raw = props.secretEnvVarNames && props.secretEnvVarNames.length > 0
            ? props.secretEnvVarNames
            : [normalizedSecretEnvVarName];
        const uniq: string[] = [];
        for (const n of raw) {
            const v = String(n ?? '').trim().toUpperCase();
            if (!v) continue;
            if (!uniq.includes(v)) uniq.push(v);
        }
        return uniq;
    }, [normalizedSecretEnvVarName, props.secretEnvVarNames]);

    const [activeEnvVarName, setActiveEnvVarName] = React.useState(() => normalizedSecretEnvVarName);
    const activeServerId = Object.prototype.hasOwnProperty.call(props, 'accountScope')
        ? props.accountScope?.serverId ?? '' : getActiveServerId();
    const { binding } = useServerCredentialAccountScopeBinding(activeServerId);
    const machineScope = binding?.isCurrent() && (!props.accountScope || areServerAccountScopesEqual(binding.scope, props.accountScope))
        ? binding.scope : null;
    const envPresence = useMachineEnvPresence(
        props.machineId,
        secretEnvVarNames,
        { ttlMs: 2 * 60_000, serverId: activeServerId },
    );
    const machine = useServerScopedMachine(activeServerId, props.machineId ?? '');
    const observedMachines = React.useMemo(() => machine ? [machine] : [], [machine]);
    const presenceNowMs = useMachinePresenceNowMs(observedMachines);
    const reachabilityRevision = useMachineReachabilityRevision(Boolean(machine));

    const variant: SecretRequirementModalVariant = props.variant ?? 'requirement';

    const [sessionOnlyValue, setSessionOnlyValue] = React.useState(() => {
        const initial = props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName];
        return typeof initial === 'string' ? initial : '';
    });
    const sessionOnlyInputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    const selectionKey = `${props.profile.id}:${activeEnvVarName}:${props.machineId ?? 'no-machine'}`;
    const [selectedSource, setSelectedSource] = React.useState<'machine' | 'saved' | 'once' | null>(() => {
        if (variant === 'defaultForProfile') return 'saved';
        const selectedRaw = props.selectedSecretIdByEnvVarName?.[activeEnvVarName];
        const hasSessionOnly = typeof props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName] === 'string'
            && String(props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName]).length > 0;
        if (hasSessionOnly) return 'once';
        if (selectedRaw === '') return 'machine';
        if (typeof selectedRaw === 'string' && selectedRaw.trim().length > 0) return 'saved';
        // Default later once machine-env status is known.
        return null;
    });

    const [localDefaultSecretId, setLocalDefaultSecretId] = React.useState<string | null>(() => {
        const byName = props.defaultSecretIdByEnvVarName?.[activeEnvVarName];
        if (typeof byName === 'string') return byName;
        return props.defaultSecretId ?? null;
    });

    const machineHasRequiredSecret = React.useMemo(() => {
        if (!props.machineId) return null;
        if (!activeEnvVarName) return null;
        if (envPresence.isLoading) return null;
        if (!envPresence.isPreviewEnvSupported) return null;
        return Boolean(envPresence.meta[activeEnvVarName]?.isSet);
    }, [activeEnvVarName, envPresence.isLoading, envPresence.isPreviewEnvSupported, envPresence.meta, props.machineId]);

    const machineName = React.useMemo(() => {
        if (!props.machineId) return null;
        if (!machine) return props.machineId;
        return getMachineSentenceName(machine);
    }, [machine, props.machineId]);

    const machineNameColor = React.useMemo(() => {
        if (!props.machineId) return theme.colors.text.secondary;
        if (!machine) return theme.colors.text.secondary;
        const presence = resolveMachineReachability(machineScope, machine, presenceNowMs);
        return presence === 'reachable' ? theme.colors.status.connected : presence === 'unreachable' ? theme.colors.status.disconnected : theme.colors.text.secondary;
    }, [machine, machineScope, presenceNowMs, reachabilityRevision, props.machineId, theme.colors.status.connected, theme.colors.status.disconnected, theme.colors.text.secondary]);

    const allowedSources = React.useMemo(() => {
        const sources: Array<'machine' | 'saved' | 'once'> = [];
        if (variant === 'defaultForProfile') {
            sources.push('saved');
            return sources;
        }
        if (props.machineId) sources.push('machine');
        sources.push('saved');
        if (props.allowSessionOnly !== false) sources.push('once');
        return sources;
    }, [props.allowSessionOnly, props.machineId, variant]);

    React.useEffect(() => {
        if (selectedSource && allowedSources.includes(selectedSource)) return;
        if (variant === 'defaultForProfile') {
            setSelectedSource('saved');
            return;
        }
        setSelectedSource(null);
    }, [allowedSources, localDefaultSecretId, props.defaultSecretId, props.machineId, selectedSource, variant]);

    React.useEffect(() => {
        if (!selectedSource) return;
        secretRequirementSelectionMemory.set(selectionKey, selectedSource);
    }, [selectionKey, selectedSource]);

    // When "Use once" is selected, focus the input. This avoids cases where touch handling
    // inside nested modal/list layouts makes the TextInput hard to focus.
    React.useEffect(() => {
        if (selectedSource !== 'once') return;
        const id = setTimeout(() => {
            sessionOnlyInputRef.current?.focus();
        }, 50);
        return () => clearTimeout(id);
    }, [selectedSource]);

    const machineEnvTitle = React.useMemo(() => {
        const envName = activeEnvVarName || t('profiles.requirements.secretRequired');
        if (!props.machineId) return t('profiles.requirements.machineEnvStatus.checkFor', { env: envName });
        const target = machineName ?? t('profiles.requirements.machineEnvStatus.theMachine');
        if (envPresence.isLoading) return t('profiles.requirements.machineEnvStatus.checking', { env: envName });
        if (machineHasRequiredSecret) return t('profiles.requirements.machineEnvStatus.found', { env: envName, machine: target });
        return t('profiles.requirements.machineEnvStatus.notFound', { env: envName, machine: target });
    }, [activeEnvVarName, envPresence.isLoading, machineHasRequiredSecret, machineName, props.machineId]);

    const machineEnvSubtitle = React.useMemo(() => {
        if (!props.machineId) return undefined;
        if (envPresence.isLoading) return t('profiles.requirements.machineEnvSubtitle.checking');
        if (machineHasRequiredSecret) return t('profiles.requirements.machineEnvSubtitle.found');
        return t('profiles.requirements.machineEnvSubtitle.notFound');
    }, [envPresence.isLoading, machineHasRequiredSecret, props.machineId]);

    const activeSelectedSavedSecretId = React.useMemo(() => {
        const selectedRaw = props.selectedSecretIdByEnvVarName?.[activeEnvVarName];
        if (typeof selectedRaw === 'string' && selectedRaw.trim().length > 0 && selectedRaw !== '') {
            return selectedRaw;
        }
        if (activeEnvVarName === normalizedSecretEnvVarName) {
            return props.selectedSavedSecretId ?? null;
        }
        return null;
    }, [activeEnvVarName, normalizedSecretEnvVarName, props.selectedSavedSecretId, props.selectedSecretIdByEnvVarName]);

    const activeDefaultSecretId = React.useMemo(() => {
        const byName = props.defaultSecretIdByEnvVarName?.[activeEnvVarName];
        if (typeof byName === 'string' && byName.trim().length > 0) return byName;
        if (activeEnvVarName === normalizedSecretEnvVarName) return props.defaultSecretId ?? null;
        return null;
    }, [activeEnvVarName, normalizedSecretEnvVarName, props.defaultSecretId, props.defaultSecretIdByEnvVarName]);

    const [showChoiceDropdown, setShowChoiceDropdown] = React.useState(false);
    const [showEnvVarDropdown, setShowEnvVarDropdown] = React.useState(false);

    // If the machine env option is disabled, never show it as the selected option.
    React.useEffect(() => {
        if (variant !== 'requirement') return;
        if (selectedSource === 'machine' && machineHasRequiredSecret !== true) {
            setSelectedSource('saved');
        }
        // If nothing has been selected yet, default to the first enabled option.
        if (selectedSource === null) {
            // Precedence (no explicit session override):
            // - default saved secret (if set) wins
            // - else machine env (if detected) wins
            // - else saved secret option
            if (activeDefaultSecretId) {
                setSelectedSource('saved');
                return;
            }
            if (props.machineId && machineHasRequiredSecret === true) {
                setSelectedSource('machine');
                return;
            }
            setSelectedSource('saved');
        }
    }, [activeDefaultSecretId, machineHasRequiredSecret, props.machineId, selectedSource, variant]);

    React.useEffect(() => {
        // When switching which env var we're resolving, restore any stored session-only value
        // and default the source based on current state.
        const nextSessionOnly = props.sessionOnlySecretValueByEnvVarName?.[activeEnvVarName];
        setSessionOnlyValue(typeof nextSessionOnly === 'string' ? nextSessionOnly : '');

        const selectedRaw = props.selectedSecretIdByEnvVarName?.[activeEnvVarName];
        const hasSessionOnly = typeof nextSessionOnly === 'string' && nextSessionOnly.length > 0;
        if (variant === 'defaultForProfile') {
            setSelectedSource('saved');
            return;
        }
        if (hasSessionOnly) {
            setSelectedSource('once');
            return;
        }
        if (selectedRaw === '') {
            setSelectedSource('machine');
            return;
        }
        if (typeof selectedRaw === 'string' && selectedRaw.trim().length > 0) {
            setSelectedSource('saved');
            return;
        }
        if (activeDefaultSecretId) {
            setSelectedSource('saved');
            return;
        }
        if (props.machineId && machineHasRequiredSecret === true) {
            setSelectedSource('machine');
            return;
        }
        setSelectedSource('saved');
    }, [
        activeDefaultSecretId,
        activeEnvVarName,
        machineHasRequiredSecret,
        props.machineId,
        props.selectedSecretIdByEnvVarName,
        props.sessionOnlySecretValueByEnvVarName,
        variant,
    ]);

    return (
        <View style={layoutVariant === 'screen' ? styles.containerScreen : styles.containerChrome}>
            {layoutVariant === 'screen' ? (
                <View style={styles.header}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.headerTitle}>
                            {props.titleOverride ?? t('profiles.requirements.modalTitle')}
                        </Text>
                        <Text style={styles.headerSubtitle} numberOfLines={1}>
                            {props.profile.name}
                        </Text>
                    </View>
                    <IconButton
                        testID="secret-requirement:close"
                        variant="plain"
                        iconName="x"
                        accessibilityLabel={t('common.close')}
                        onPress={props.onClose}
                    />
                </View>
            ) : null}

            <View style={styles.scrollWrap}>
                <ScrollView
                    ref={scrollRef}
                    style={styles.scroll}
                    contentContainerStyle={[
                        styles.scrollContent,
                        layoutVariant === 'modal' ? styles.scrollContentModal : null,
                    ]}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={true}
                    scrollEventThrottle={32}
                    onLayout={fades.onViewportLayout}
                    onContentSizeChange={fades.onContentSizeChange}
                    onScroll={wheelScrollHandlers.onScroll}
                    {...(Platform.OS === 'web' ? ({ onWheel: wheelScrollHandlers.onWheel } as any) : {})}
                >
                {variant === 'requirement' ? (
                    <View style={styles.helpContainer}>
                        <Text style={styles.helpText}>
                            {activeEnvVarName
                                ? t('profiles.requirements.modalHelpWithEnv', { env: activeEnvVarName })
                                : t('profiles.requirements.modalHelpGeneric')}
                        </Text>
                    </View>
                ) : null}

                <ItemListStatic style={{ backgroundColor: 'transparent' }} containerStyle={{ paddingTop: 0 }}>
                    {variant === 'requirement' && secretEnvVarNames.length > 1 ? (
                        <ItemGroup title="" containerStyle={{ backgroundColor: 'transparent' }}>
                            <DropdownMenu
                                open={showEnvVarDropdown}
                                onOpenChange={setShowEnvVarDropdown}
                                variant="selectable"
                                search={false}
                                selectedId={activeEnvVarName}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={null}
                                popoverPortalWebTarget="body"
                                trigger={({ open, toggle }) => (
                                    <View
                                        style={[
                                            open ? shadowLevelStyle(theme.colors.shadowLevels[4]) : null,
                                            {
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                backgroundColor: open
                                                    ? (theme.dark ? theme.colors.surface.elevated : theme.colors.surface.inset)
                                                    : theme.colors.surface.base,
                                            },
                                        ]}
                                    >
                                        <Item
                                            selected={false}
                                            title={activeEnvVarName}
                                            icon={<Icon name="key" size={24} color={theme.colors.text.secondary} />}
                                            rightElement={(
                                                <Icon
                                                    name={open ? 'caret-up' : 'caret-down'}
                                                    size={20}
                                                    color={theme.colors.text.secondary}
                                                />
                                            )}
                                            showChevron={false}
                                            showDivider={false}
                                            onPress={toggle}
                                            pressableStyle={{
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                overflow: 'hidden',
                                            }}
                                        />
                                    </View>
                                )}
                                items={secretEnvVarNames.map((name) => ({
                                    id: name,
                                    title: name,
                                    subtitle: undefined,
                                    icon: (
                                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                            <Icon name="key" size={24} color={theme.colors.text.secondary} />
                                        </View>
                                    ),
                                }))}
                                onSelect={(id) => {
                                    setActiveEnvVarName(id);
                                }}
                            />
                        </ItemGroup>
                    ) : null}
                    {variant === 'requirement' ? (
                        <ItemGroup title={t('profiles.requirements.chooseOptionTitle')} containerStyle={{ backgroundColor: 'transparent' }}>
                            <DropdownMenu
                                open={showChoiceDropdown}
                                onOpenChange={setShowChoiceDropdown}
                                variant="selectable"
                                search={false}
                                selectedId={selectedSource}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={null}
                                popoverPortalWebTarget="body"
                                trigger={({ open, toggle }) => (
                                    <View
                                        style={[
                                            // When open, use the same shadow "strength" as FloatingOverlay, but bias it
                                            // upward so the trigger is visually separated from the background.
                                            open ? shadowLevelStyle(theme.colors.shadowLevels[4]) : null,
                                            {
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                backgroundColor: open
                                                    ? (theme.dark ? theme.colors.surface.elevated : theme.colors.surface.inset)
                                                    : theme.colors.surface.base,
                                            },
                                        ]}
                                    >
                                        <Item
                                            // Provide `selected={false}` so Item can apply "selectable hover" affordances on web.
                                            selected={false}
                                            title={
                                                selectedSource === 'saved'
                                                    ? t('profiles.requirements.options.useSavedSecret.title')
                                                    : selectedSource === 'once'
                                                        ? t('profiles.requirements.options.enterOnce.title')
                                                    : selectedSource === 'machine'
                                                        ? machineEnvTitle
                                                        : t('profiles.requirements.chooseOptionTitle')
                                            }
                                            subtitle={
                                                selectedSource === 'saved'
                                                    ? t('profiles.requirements.options.useSavedSecret.subtitle')
                                                    : selectedSource === 'once'
                                                        ? t('profiles.requirements.options.enterOnce.subtitle')
                                                    : selectedSource === 'machine'
                                                        ? machineEnvSubtitle
                                                        : undefined
                                            }
                                            icon={(
                                                <Icon
                                                    name={
                                                        selectedSource === 'saved'
                                                            ? 'key'
                                                            : selectedSource === 'once'
                                                                ? 'lightning'
                                                            : selectedSource === 'machine'
                                                                ? 'desktop'
                                                                : 'sliders-horizontal'
                                                    }
                                                    size={24}
                                                    color={theme.colors.text.secondary}
                                                />
                                            )}
                                            rightElement={(
                                                <Icon
                                                    name={open ? 'caret-up' : 'caret-down'}
                                                    size={20}
                                                    color={theme.colors.text.secondary}
                                                />
                                            )}
                                            showChevron={false}
                                            showDivider={false}
                                            onPress={toggle}
                                            pressableStyle={{
                                                borderRadius: 12,
                                                borderBottomLeftRadius: open ? 0 : 12,
                                                borderBottomRightRadius: open ? 0 : 12,
                                                // Keep clipping for rounded corners, but the shadow comes from the wrapper above.
                                                overflow: 'hidden',
                                            }}
                                        />
                                    </View>
                                )}
                                items={[
                                    ...(props.machineId ? [{
                                        id: 'machine',
                                        title: machineEnvTitle,
                                        subtitle: machineEnvSubtitle,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Icon name="desktop" size={24} color={theme.colors.text.secondary} />
                                            </View>
                                        ),
                                        disabled: machineHasRequiredSecret !== true,
                                    }] : []),
                                    {
                                        id: 'saved',
                                        title: t('profiles.requirements.options.useSavedSecret.title'),
                                        subtitle: t('profiles.requirements.options.useSavedSecret.subtitle'),
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Icon name="key" size={24} color={theme.colors.text.secondary} />
                                            </View>
                                        ),
                                    },
                                    ...(props.allowSessionOnly !== false ? [{
                                        id: 'once',
                                        title: t('profiles.requirements.options.enterOnce.title'),
                                        subtitle: t('profiles.requirements.options.enterOnce.subtitle'),
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Icon name="lightning" size={24} color={theme.colors.text.secondary} />
                                            </View>
                                        ),
                                    }] : []),
                                ]}
                                onSelect={(id) => {
                                    if (id === 'machine') {
                                        if (machineHasRequiredSecret === true) {
                                            setSelectedSource('machine');
                                            props.onResolve({ action: 'useMachine', envVarName: activeEnvVarName });
                                            props.onClose();
                                        }
                                        return;
                                    }
                                    setSelectedSource(id as any);
                                }}
                            />
                        </ItemGroup>
                    ) : null}

                    {selectedSource === 'saved' && (
                        <SecretsList
                            wrapInItemList={false}
                            secrets={savedSecretCatalog.personalSecrets}
                            sharedEntries={savedSecretCatalog.sharedEntries}
                            resolveSharedReference={savedSecretCatalog.resolveReference}
                            onCreatePersonal={canManage ? savedSecretCatalog.personalMutations.create : undefined}
                            allowAdd={canManage}
                            allowEdit={false}
                            title={t('secrets.savedTitle')}
                            footer={null}
                            includeNoneRow={variant === 'defaultForProfile'}
                            noneSubtitle={variant === 'defaultForProfile' ? t('secrets.noneSubtitle') : undefined}
                            selectedId={variant === 'defaultForProfile'
                                ? (localDefaultSecretId ?? '')
                                : (activeSelectedSavedSecretId ?? '')
                            }
                            onSelectId={(id) => {
                                if (variant === 'defaultForProfile') {
                                    const current = localDefaultSecretId ?? null;
                                    const next = id === '' ? null : id;

                                    // UX: tapping the currently-selected default should unset it.
                                    if (next === current) {
                                        setLocalDefaultSecretId(null);
                                        props.onSetDefaultSecretId?.(null);
                                        props.onResolve({ action: 'cancel' });
                                        props.onClose();
                                        return;
                                    }

                                    setLocalDefaultSecretId(next);
                                    props.onSetDefaultSecretId?.(next);
                                    if (next) {
                                        props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: next, setDefault: true });
                                    } else {
                                        props.onResolve({ action: 'cancel' });
                                    }
                                    props.onClose();
                                    return;
                                }
                                if (!id) return;
                                props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: id, setDefault: false });
                                props.onClose();
                            }}
                            onAfterAddSelectId={(id) => {
                                if (variant === 'defaultForProfile') {
                                    setLocalDefaultSecretId(id);
                                    if (props.onSetDefaultSecretId) {
                                        props.onSetDefaultSecretId(id);
                                    }
                                    props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: id, setDefault: true });
                                    props.onClose();
                                    return;
                                }
                                props.onResolve({ action: 'selectSaved', envVarName: activeEnvVarName, secretId: id, setDefault: false });
                                props.onClose();
                            }}
                        />
                    )}

                    {/* Renaming, replacing and deleting live on the Secrets page; the prompt leads there, last. */}
                    {selectedSource === 'saved' ? (
                        <ItemGroup>
                            <Item
                                testID="secret-requirement:manage"
                                title={t('profiles.requirements.manageSavedSecrets')}
                                // It closes the prompt without a choice, so it says so; adding a key stays in the list above.
                                subtitle={t('profiles.requirements.manageSavedSecretsSubtitle')}
                                icon={<Icon name="gear" size={24} color={theme.colors.text.secondary} />}
                                onPress={openSecretsSettings}
                                showDivider={false}
                            />
                        </ItemGroup>
                    ) : null}

                    {selectedSource === 'once' && props.allowSessionOnly !== false && (
                        <ItemGroup title={t('profiles.requirements.sections.useOnceTitle')} description={t('profiles.requirements.sections.useOnceFooter')}>
                            <View style={{ paddingHorizontal: theme.space.s16, paddingTop: theme.space.s12, paddingBottom: theme.space.s16 }}>
                                <Text style={styles.fieldLabel}>{t('profiles.requirements.sections.useOnceLabel')}</Text>
                                <TextInput
                                    ref={sessionOnlyInputRef}
                                    style={styles.textInput}
                                    placeholder={t('secrets.placeholders.valueExample')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    value={sessionOnlyValue}
                                    onChangeText={setSessionOnlyValue}
                                    autoFocus={selectedSource === 'once'}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    secureTextEntry
                                    textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                                />
                                <View style={{ height: 10 }} />
                                <RoundButton
                                    size="normal"
                                    title={t('profiles.requirements.actions.useOnceButton')}
                                    disabled={sessionOnlyValue.length === 0}
                                    onPress={() => {
                                        props.onResolve({ action: 'enterOnce', envVarName: activeEnvVarName, value: sessionOnlyValue });
                                        props.onClose();
                                    }}
                                />
                            </View>
                        </ItemGroup>
                    )}
                </ItemListStatic>
                </ScrollView>

                <ScrollEdgeFades
                    color={theme.colors.background.canvas}
                    size={18}
                    edges={fades.visibility}
                />
                <ScrollEdgeIndicators
                    edges={fades.visibility}
                    color={theme.colors.text.secondary}
                    size={14}
                    opacity={0.35}
                />
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    containerChrome: {
        flex: 1,
        minHeight: 0,
        width: '100%',
        backgroundColor: theme.colors.background.canvas,
        alignSelf: 'stretch',
    },
    containerScreen: {
        flex: 1,
        width: '100%',
        backgroundColor: theme.colors.background.canvas,
        borderRadius: 0,
        overflow: 'hidden',
        borderWidth: 0,
        alignSelf: 'stretch',
    },
    header: {
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 14,
        paddingBottom: theme.space.s12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    headerSubtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s2,
    },
    scrollWrap: {
        position: 'relative',
        flex: 1,
        minHeight: 0,
    },
    scroll: {
        flex: 1,
        minHeight: 0,
    },
    scrollContent: {
        paddingBottom: 18,
    },
    scrollContentModal: {
        paddingTop: theme.space.s12,
    },
    helpContainer: {
        width: '100%',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 14,
        paddingBottom: theme.space.s8,
        alignSelf: 'center',
    },
    helpText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
    },
    fieldLabel: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s4,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
}));
