import * as React from 'react';

import { useLocalSettingMutable, useSetting } from '@/sync/domains/state/storage';

import {
    isComposerBannerCollapsedInRecord,
    planComposerBannerCollapseToggle,
    resolveComposerBannerCollapseState,
    type ComposerBannerCollapseRecord,
} from './composerBannerCollapse';
import type { SessionComposerBannerKind } from './composerBannerKinds';

type ComposerBannerCollapseContextValue = Readonly<{
    collapsedKinds: ComposerBannerCollapseRecord;
    ephemeralCollapsedKinds: ComposerBannerCollapseRecord;
    toggle: (kind: SessionComposerBannerKind, persistence: 'preference' | 'ephemeral') => void;
}>;

const ComposerBannerCollapseContext = React.createContext<ComposerBannerCollapseContextValue | null>(null);

/**
 * Single owner of composer banner collapse for one session surface.
 *
 * A banner and the status badge that toggles it live in different subtrees (the badge sits in the
 * composer action bar, some banners sit in the transcript footer slot), so the state cannot be
 * component-local. It also must not be module-global: while the remember preference is off,
 * collapsing has to die with this session surface exactly as it did before the preference existed.
 * A provider scoped to the session surface is the only shape that satisfies both.
 */
export function ComposerBannerCollapseProvider(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const remember = useSetting('sessionComposerRememberBannerVisibility') === true;
    const [persisted, setPersisted] = useLocalSettingMutable('sessionComposerCollapsedBannerKinds');
    const [ephemeral, setEphemeral] = React.useState<ComposerBannerCollapseRecord>({});

    const collapsedKinds = React.useMemo(
        () => resolveComposerBannerCollapseState({ remember, persisted, ephemeral }),
        [ephemeral, persisted, remember],
    );

    // The toggle handler is handed to memoized badge descriptors, so it stays referentially stable
    // across collapse changes and reads the freshest inputs through refs instead of dependencies.
    const inputsRef = React.useRef({ remember, persisted, ephemeral });
    inputsRef.current = { remember, persisted, ephemeral };
    const toggle = React.useCallback((kind: SessionComposerBannerKind, persistence: 'preference' | 'ephemeral') => {
        const inputs = inputsRef.current;
        const plan = planComposerBannerCollapseToggle({
            remember: persistence === 'preference' && inputs.remember,
            persisted: inputs.persisted,
            ephemeral: inputs.ephemeral,
            kind,
        });
        if (plan.persisted) setPersisted(plan.persisted);
        if (plan.ephemeral) setEphemeral(plan.ephemeral);
    }, [setPersisted]);

    const value = React.useMemo(() => ({ collapsedKinds, ephemeralCollapsedKinds: ephemeral, toggle }), [collapsedKinds, ephemeral, toggle]);

    return (
        <ComposerBannerCollapseContext.Provider value={value}>
            {props.children}
        </ComposerBannerCollapseContext.Provider>
    );
}

export type ComposerBannerCollapseState = Readonly<{
    collapsed: boolean;
    toggle: () => void;
}>;

export function useComposerBannerCollapse(
    kind: SessionComposerBannerKind,
    options?: Readonly<{ persistence?: 'preference' | 'ephemeral' }>,
): ComposerBannerCollapseState {
    const context = React.useContext(ComposerBannerCollapseContext);
    const persistence = options?.persistence ?? 'preference';
    const collapsed = isComposerBannerCollapsedInRecord(
        persistence === 'ephemeral' ? context?.ephemeralCollapsedKinds : context?.collapsedKinds,
        kind,
    );
    const contextToggle = context?.toggle;
    const toggle = React.useCallback(() => {
        contextToggle?.(kind, persistence);
    }, [contextToggle, kind, persistence]);

    return React.useMemo(() => ({ collapsed, toggle }), [collapsed, toggle]);
}
