import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DeviceStage } from '@/demo/DeviceStage';
import { DirectSessionsPillar } from './DirectSessionsPillar';
import { RemoteLaunchPillar } from './RemoteLaunchPillar';

function findDeviceStage(
    node: ReactNode,
): ReactElement<{ scenario?: { id?: string }; phoneView?: string; desktopView?: string }> | null {
    if (!isValidElement(node)) return null;
    if (node.type === DeviceStage) {
        return node as ReactElement<{
            scenario?: { id?: string };
            phoneView?: string;
            desktopView?: string;
        }>;
    }

    const props = node.props as { children?: ReactNode; visual?: ReactNode };
    return findDeviceStage(props.visual) ?? findDeviceStage(props.children);
}

describe('website pillar demo stages', () => {
    it('wires remote launch into the cinematic stage with the new-session phone view', () => {
        const stage = findDeviceStage(RemoteLaunchPillar());
        expect(stage?.props.scenario?.id).toBe('remoteLaunch');
        expect(stage?.props.phoneView).toBe('phone-new-session');
    });

    it('wires direct sessions into the cinematic stage with the direct-browse desktop view', () => {
        const stage = findDeviceStage(DirectSessionsPillar());
        expect(stage?.props.scenario?.id).toBe('directSessions');
        expect(stage?.props.desktopView).toBe('direct-browse');
    });
});
