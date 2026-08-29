import * as React from 'react';

import { isDesktopOverlayWindowContext } from '@/desktop/window/isDesktopOverlayWindowContext';

import { PersonalHomeSetupSurface } from '../setup/PersonalHomeSetupSurface';
import type { PersonalHomeBootstrapOperation, PersonalHomeFacts } from './personalHomeBootstrapTypes';
import {
    isPersonalHomeDesktopHost,
    usePersonalHomeBootstrapController,
    type PersonalHomeBootstrapOperationRunner,
} from './usePersonalHomeBootstrapController';

export type PersonalHomeBootstrapGateProps = Readonly<{
    children: React.ReactNode;
    /** Fact collection is supplied by the runtime/profile/auth owners. */
    readFacts?: () => Promise<PersonalHomeFacts>;
    operations?: Partial<Record<PersonalHomeBootstrapOperation, PersonalHomeBootstrapOperationRunner>>;
    initialFacts?: PersonalHomeFacts | null;
    isDesktopHost?: boolean;
    isDesktopMainWindow?: boolean;
    onUseExisting?: () => void;
    onUseAnotherHome?: () => void;
    onOpenDetails?: () => void;
    setupSurface?: (props: React.ComponentProps<typeof PersonalHomeSetupSurface>) => React.ReactNode;
}>;

function passThroughFacts(): Promise<PersonalHomeFacts> {
    return Promise.resolve({
        hostIsDesktop: false,
        isDesktopMainWindow: false,
        completedPersonalHomeProfile: null,
        candidateLocalProfile: null,
        relayRuntime: null,
        localHomeReachability: 'unknown',
        localHomeIdentity: null,
        localHomeAuth: 'unknown',
        anonymousSignup: 'unknown',
        daemon: null,
        activeTask: null,
    });
}

/**
 * Desktop main-window-only shell gate. Overlay/callback windows and mobile/web hosts never enter
 * the Personal Home setup owner. The normal shell remains the child tree once Home readiness is
 * derived from facts; there is no success route or remounted frame.
 */
export function PersonalHomeBootstrapGate(props: PersonalHomeBootstrapGateProps): React.ReactElement {
    const isDesktop = props.isDesktopHost ?? isPersonalHomeDesktopHost();
    const isMainWindow = props.isDesktopMainWindow ?? !isDesktopOverlayWindowContext();
    const enabled = isDesktop && isMainWindow && props.readFacts != null;
    const controller = usePersonalHomeBootstrapController({
        readFacts: props.readFacts ?? passThroughFacts,
        operations: props.operations,
        initialFacts: props.initialFacts,
        enabled,
    });

    if (!enabled || !controller.snapshot.shouldGateShell) {
        return <>{props.children}</>;
    }

    const setupProps: React.ComponentProps<typeof PersonalHomeSetupSurface> = {
        snapshot: controller.snapshot,
        activeTask: controller.facts?.activeTask ?? null,
        onRetry: controller.retry,
        onOpenDetails: props.onOpenDetails,
        onUseExisting: props.onUseExisting,
        onUseAnotherHome: props.onUseAnotherHome,
    };
    return (
        <>
            {props.setupSurface ? props.setupSurface(setupProps) : <PersonalHomeSetupSurface {...setupProps} />}
        </>
    );
}
