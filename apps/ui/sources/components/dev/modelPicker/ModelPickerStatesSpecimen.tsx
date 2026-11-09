import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionModelPicker, type SessionModelPickerProps } from '@/components/sessions/modelPicker/SessionModelPicker';
import { SessionModelSourceUsage } from '@/components/sessions/modelPicker/SessionModelSourceUsage';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';

const noop = () => {};
const MODELS = [
    { value: 'default', label: 'Use CLI settings', description: 'Configure models in CLI settings' },
    { value: 'opus-5-5', label: 'Opus 5.5', description: 'Latest Opus model for long-running agentic and knowledge work.' },
    { value: 'sonnet-5', label: 'Sonnet 5', description: 'Latest balanced Claude model for coding, agentic work, editing, and analysis.' },
];

const BASE: Pick<SessionModelPickerProps,
    'agentTargetKey' | 'providerGroups' | 'providerProjectionAuthoritative' | 'selected' | 'onSelect'> = {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerGroups: [],
    providerProjectionAuthoritative: false,
    selected: null,
    onSelect: noop,
};

/** A browsed source's balance line, which a Home without a usage-reporting source cannot show. */
const SOURCE_USAGE = {
    supported: true,
    refreshing: false,
    failed: false,
    pendingApproval: null,
    presentation: {
        groups: [{ scope: 'account' as const, meters: [{
            meterId: 'balance', label: 'Balance', unit: 'usd', currency: 'USD',
            amount: { kind: 'remaining' as const, remaining: 5 }, remainingPct: null, tone: 'neutral' as const, estimated: false,
        }] }],
        billingSlots: [], checked: true, fetchedAt: Date.UTC(2026, 10, 5, 9, 8), sourceErrors: [], connectionError: null,
    },
};

/** The model pane's states: `?frame=normal|loading|refreshing|empty|pending|usage`. */
function frameProps(frame: string): SessionModelPickerProps {
    const none = { ...BASE, nativeModels: [], allowAutomatic: false, canEnterCustomNativeValue: false };
    switch (frame) {
        case 'loading': return { ...none, probe: { phase: 'loading' } };
        case 'refreshing': return { ...none, probe: { phase: 'refreshing' } };
        case 'empty': return { ...none, probe: { phase: 'idle', onRefresh: noop } };
        case 'pending': return {
            ...none,
            probe: { phase: 'loading' },
            projectionApproval: { artifactId: 'dev-approval', href: buildApprovalHref('dev-approval', 'dev-home') },
        };
        default: return { ...BASE, nativeModels: MODELS, probe: { phase: 'idle', onRefresh: noop } };
    }
}

/**
 * Dev-only: the New Session model pane through the real `SessionModelPicker`, for the states a live
 * Home cannot hold still (loading, empty, a refresh waiting on its approval). Never linked from product surfaces.
 */
export function ModelPickerStatesSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame = props.frame ?? 'normal';
    return (
        <View style={styles.page} testID={`model-picker-states-${frame}`}>
            <View style={styles.pane}>
                {frame === 'usage' ? <SessionModelSourceUsage usage={SOURCE_USAGE as never} onOpenApproval={null} onOpenConnection={noop} /> : null}
                <SessionModelPicker multiColumn fillAvailableSpace {...frameProps(frame)} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.base, alignItems: 'center', padding: theme.space.s16 },
    pane: { width: '100%', maxWidth: 640, height: 360 },
}));
