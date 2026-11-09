import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { useAtmosphereMoment } from '@/components/atmosphere/atmosphereMoments';
import { useAllMachines } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { PAIRING_QR_MOMENT_SUPPORTED } from './PairingQrMoment';
import { advanceQrMoment, qrMomentPanelOf, QR_MOMENT_NONE, selectQrMomentFrame, type PairingQrMomentSource, type QrMomentPanel, type QrMomentScene } from './pairingQrMomentTimeline';

export type { PairingQrMomentSource };

const panelKey = (panel: QrMomentPanel) =>
    panel.kind === 'ready' ? `ready:${panel.link}` : panel.kind === 'adding' || panel.kind === 'joined' ? `${panel.kind}:${panel.device}` : panel.kind;

/**
 * The QR and pairing moments for one code block: the scene advances on each lifecycle event (in render,
 * so the first frame is already the moment's), and `drawing` says whether the block shows the moment
 * or its static content.
 */
/** Names only: the shallow-compared string list stays quiet across live resource publications. */
function selectPairingMachineNames(allMachines: readonly Machine[]): string[] {
    const current = allMachines.filter((machine) => !isMachineReplaced(machine));
    const names = resolveMachineDisplayNames(current);
    return current.map((machine) => names.get(machine.id) ?? '').filter(Boolean);
}

export function usePairingQrMoment(source: PairingQrMomentSource) {
    const qr = useAtmosphereMoment('qr');
    const pairing = useAtmosphereMoment('pairing');
    const { theme } = useUnistyles();
    const panel = qrMomentPanelOf(source, { qr: qr.on && PAIRING_QR_MOMENT_SUPPORTED, pairing: pairing.on && PAIRING_QR_MOMENT_SUPPORTED });
    const key = panelKey(panel);
    const [state, setState] = React.useState<Readonly<{ key: string; scene: QrMomentScene }>>(() => ({
        key, scene: advanceQrMoment(QR_MOMENT_NONE, panel, performance.now()),
    }));
    let scene = state.scene;
    if (state.key !== key) {
        scene = advanceQrMoment(state.scene, panel, performance.now());
        setState({ key, scene });
    }
    const machines = useAllMachines(selectPairingMachineNames);
    const options = { reducedMotion: qr.reducedMotion, pairing: pairing.on };
    const drawing = selectQrMomentFrame(scene, performance.now(), options).request !== null;
    return { drawing, scene, theme: theme.dark ? 'dark' as const : 'light' as const, machines, ...options };
}
