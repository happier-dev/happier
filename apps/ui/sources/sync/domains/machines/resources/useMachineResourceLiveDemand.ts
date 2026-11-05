import * as React from 'react';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import { useMachineDaemonReadIdentities } from '../useMachineDaemonReadTarget';
import { machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsView } from './machineRpc';

type Demand = Readonly<{ binding: NonNullable<ReturnType<typeof useMachineDaemonReadIdentities>[number]['accountBinding']>; release(): void }>;

/** Mounted visible surfaces own demand; passive row readers never start an RPC. */
export function useMachineResourceLiveDemand(machineKeys: readonly MachineResourceKey[], options: Readonly<{ detail: MachineVitalsView; enabled?: boolean }>): void {
    const identities = useMachineDaemonReadIdentities(machineKeys.map(input => ({ ...input, enabled: options.enabled })));
    const versionsKey = JSON.stringify(identities.map((target, index) => ({ ...target.key,
        daemonStateVersion: machineKeys[index]?.daemonStateVersion })));
    // One demand per machine. A machine that comes or goes changes only its own demand, so its neighbours
    // keep their held read and watch instead of releasing and re-reading with the whole fleet.
    const demands = React.useRef(new Map<string, Demand>());

    React.useEffect(() => {
        for (const input of JSON.parse(versionsKey) as MachineResourceKey[]) {
            if (input.expectedAccountId) machineResourceStore.daemonStateChanged(input, input.daemonStateVersion);
        }
    }, [versionsKey]);

    React.useEffect(() => {
        const wanted = new Map(identities.filter(target => target.enabled).map(target => [JSON.stringify([target.key, options.detail]), target] as const));
        for (const [key, demand] of demands.current) {
            if (wanted.get(key)?.accountBinding === demand.binding) continue;
            demand.release();
            demands.current.delete(key);
        }
        for (const [key, target] of wanted) {
            if (demands.current.has(key)) continue;
            const binding = target.accountBinding!;
            const release = machineResourceStore.demand({ ...target.key, view: options.detail });
            const retirement = binding.onRetire(release);
            demands.current.set(key, { binding, release: () => { retirement.dispose(); release(); } });
        }
    }, [identities, options.detail]);

    React.useEffect(() => () => {
        for (const demand of demands.current.values()) demand.release();
        demands.current.clear();
    }, []);
}

/**
 * The same demand as a leaf: a page or list that owns demand renders this instead of calling the hook,
 * so the presentation and host-viewed facts the demand follows (a retained tab hiding, the window
 * losing focus) re-render this leaf alone, never the surface's rows, header or dashboard.
 */
type MachineResourceLiveDemandProps = Readonly<{
    machineKeys: readonly MachineResourceKey[];
    detail: MachineVitalsView;
    enabled?: boolean;
    /** A list meter follows the physical scroll host instead of the list's retained mounts. */
    viewportRef?: React.RefObject<unknown>;
    /** Keep the meter mounted and pass the incumbent measurement callback to its physical layout. */
    children?: (measure: () => void) => React.ReactNode;
}>;

export function MachineResourceLiveDemand(props: MachineResourceLiveDemandProps): React.ReactElement | null {
    if (props.enabled === false && !props.children) return null;
    return props.viewportRef
        ? React.createElement(MeasuredMachineResourceLiveDemand, { ...props, viewportRef: props.viewportRef })
        : React.createElement(PresentedMachineResourceLiveDemand, props);
}

function MeasuredMachineResourceLiveDemand(props: MachineResourceLiveDemandProps & Readonly<{ viewportRef: React.RefObject<unknown> }>) {
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const { near, measure } = useMeasuredNearViewport(tracker, props.viewportRef, true, JSON.stringify(props.machineKeys));
    return React.createElement(React.Fragment, null,
        near && props.enabled !== false ? React.createElement(PresentedMachineResourceLiveDemand, props) : null,
        props.children?.(measure));
}

function PresentedMachineResourceLiveDemand(props: MachineResourceLiveDemandProps): null {
    useMachineResourceLiveDemand(props.machineKeys, { detail: props.detail, ...(props.enabled === undefined ? {} : { enabled: props.enabled }) });
    return null;
}
