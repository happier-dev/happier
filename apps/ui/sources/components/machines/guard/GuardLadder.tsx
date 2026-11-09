import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { MachineGuardLadderV1 } from '@happier-dev/protocol/machines/guard/guardViewV1';

import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { GuardInsetFigure, GuardInsetList, GuardInsetRow } from './GuardInsetRows';
import { describeLadderSummary, describeLadderTrailing, selectNextLadderRung, type GuardLadderStep, type GuardRung } from './guardPresentation';

const CANDIDATE_ICONS = { browser: 'globe', service: 'cube', session: 'chat' } as const;

/**
 * What the memory guard would do here right now, and what it is doing in an episode (lab `RS.ladder`,
 * G1 / G2 / G8; the single owner): one numbered step per rung — the next one filled — with what it
 * would free and the real candidates beneath, a step switch when the guard is on, and the one summary
 * of what is never touched. Off, it is a preview of the same list.
 */
export const GuardLadder = React.memo(function GuardLadder(props: Readonly<{
    ladder: MachineGuardLadderV1;
    /** The sentence above the steps ("If leeroy-mbp ran short on memory right now, Happier would:"). */
    lead: React.ReactNode;
    /** Step switches are offered while the guard is on and the policy can change. */
    stepSwitches: Readonly<{ editable: boolean; onToggle: (rung: GuardRung, enabled: boolean) => void }> | null;
    othersWorkCount: number;
}>) {
    const next = selectNextLadderRung(props.ladder);
    const summary = describeLadderSummary(props.ladder.summary);
    // "Up to 0 B of the 0 B in use" says nothing: with no candidate, each step already says so itself.
    const hasCandidates = props.ladder.steps.some(step => step.candidates.length > 0);
    const layout = useMachineTabCompactLayout();
    return (
        <View testID="machine-guard-ladder" onLayout={layout.onLayout} accessibilityRole="list" accessibilityLabel={t('machineGuard.ladder.label')}>
            <View style={[styles.row, styles.divider]}>
                <Text style={styles.lead}>{props.lead}</Text>
            </View>
            {props.ladder.steps.map((step, index) => (
                <LadderStep key={step.rung} step={step} number={index + 1} next={step.rung === next} switches={props.stepSwitches} compact={layout.compact} />
            ))}
            {hasCandidates ? (
                <View style={[styles.row, styles.indented, styles.divider]}>
                    <Text testID="machine-guard-ladder-summary" style={styles.summary}>
                        {`${t('machineGuard.ladder.summaryLead')} `}
                        <Text style={styles.summaryStrong}>{summary.amount}</Text>
                        {` ${summary.of}`}
                        {summary.rest ? ` ${summary.rest}` : ''}
                        {props.othersWorkCount > 0 ? ` ${t('machineGuard.states.othersWork', { count: props.othersWorkCount })}` : ''}
                    </Text>
                </View>
            ) : null}
            <NeverTouchedLine text={t('machineGuard.neverTouched')} />
        </View>
    );
});

const RUNGS: readonly GuardRung[] = ['browsers', 'devServers', 'idleSessions'];

/**
 * The ladder while the machine's first answer is still out (lab `rg` G9 4): the steps are known, so they stand at
 * their place with their titles; only what each would free is reserved until the machine says.
 */
export const GuardLadderReserved = React.memo(function GuardLadderReserved(props: Readonly<{ lead: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const layout = useMachineTabCompactLayout();
    const figure = <HappierSkeletonBlock color={theme.colors.surface.skeleton} width={88} height={12} />;
    return (
        <View testID="machine-guard-ladder-reserved" onLayout={layout.onLayout} accessibilityRole="list" accessibilityLabel={t('machineGuard.ladder.label')}>
            <View style={[styles.row, styles.divider]}>
                <Text style={styles.lead}>{props.lead}</Text>
            </View>
            {RUNGS.map((rung, index) => (
                <View key={rung} style={[styles.row, styles.divider]}>
                    <View style={styles.stepHead}>
                        <View style={styles.chipSlot}>
                            <View style={styles.chip}><Text style={styles.chipText}>{String(index + 1)}</Text></View>
                        </View>
                        <View style={styles.stepBody}>
                            <View style={styles.stepTitleRow}>
                                <Text style={[styles.stepTitle, styles.quietTitle]} numberOfLines={2}>{t(`machineGuard.ladder.${rung}.title`)}</Text>
                                {layout.compact ? null : figure}
                            </View>
                            {layout.compact ? figure : null}
                            <Text style={styles.stepHelp}>{t(`machineGuard.ladder.${rung}.help`)}</Text>
                        </View>
                    </View>
                </View>
            ))}
            <NeverTouchedLine text={t('machineGuard.neverTouched')} />
        </View>
    );
});

/** The quiet lock line closing a rule ("Never touched: …", "Only finished sessions …"). */
export function NeverTouchedLine(props: Readonly<{ text: string; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={[styles.row, styles.lockRow]}>
            <View style={styles.chipSlot}><Icon name="lock" size={13} color={theme.colors.text.tertiary} /></View>
            <Text style={styles.lock}>{props.text}</Text>
        </View>
    );
}

const LadderStep = React.memo(function LadderStep(props: Readonly<{
    step: GuardLadderStep;
    number: number;
    next: boolean;
    switches: Readonly<{ editable: boolean; onToggle: (rung: GuardRung, enabled: boolean) => void }> | null;
    /** A phone-width ladder says what a step frees under its title, not beside it (lab `rg` G2p). */
    compact: boolean;
}>) {
    const { theme } = useUnistyles();
    const { step } = props;
    const trailing = describeLadderTrailing(step);
    const title = t(`machineGuard.ladder.${step.rung}.title`);
    const quiet = trailing.kind === 'off' || trailing.kind === 'nothing';
    const largest = step.candidates.reduce((max, candidate) => Math.max(max, candidate.footprintBytes), 0);
    const trailingText = trailing.kind === 'frees' ? t('machineGuard.ladder.freesAbout', { amount: formatMachineBytes(trailing.bytes, 'memory') })
        : trailing.kind === 'nothing' ? t('machineGuard.ladder.nothingEligible')
            : trailing.kind === 'off' ? t('machineGuard.off')
                : trailing.kind === 'checking' ? t('machineGuard.ladder.checking') : t('machineGuard.ladder.done');
    const { switches } = props;
    return (
        <View testID={`machine-guard-step-${step.rung}`} accessibilityRole="none" style={[styles.row, styles.divider]}
            accessibilityLabel={t('machineGuard.ladder.stepLabel', { step: props.number, title })}>
            <View style={styles.stepHead}>
                <View style={styles.chipSlot}>
                    {trailing.kind === 'checking' ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                        : trailing.kind === 'done' ? (
                            <View style={[styles.chip, styles.chipDone]}><Icon name="check" size={12} color={theme.colors.text.secondary} /></View>
                        ) : (
                            <View style={[styles.chip, props.next ? styles.chipNext : null]}>
                                <Text style={[styles.chipText, props.next ? styles.chipTextNext : null]}>{String(props.number)}</Text>
                            </View>
                        )}
                </View>
                <View style={styles.stepBody}>
                    <View style={styles.stepTitleRow}>
                        <Text style={[styles.stepTitle, quiet ? styles.quietTitle : null]} numberOfLines={2}>{title}</Text>
                        <View style={styles.stepTrailing}>
                            {props.compact ? null : <Text style={styles.trailing} numberOfLines={1}>{trailingText}</Text>}
                            {switches ? (
                                // The switch's hit box is taller than the title line; the slot centres it on that line (the shared
                                // switch aligns itself to the start of its cross axis, so a row's own centring doesn't reach it).
                                <View style={styles.switchSlot}>
                                    <Switch testID={`machine-guard-step-${step.rung}-switch`} value={step.enabled} disabled={!switches.editable}
                                        accessibilityLabel={title} onValueChange={enabled => switches.onToggle(step.rung, enabled)} />
                                </View>
                            ) : null}
                        </View>
                    </View>
                    {props.compact ? <Text style={styles.trailing} numberOfLines={1}>{trailingText}</Text> : null}
                    <Text style={styles.stepHelp}>
                        {t(step.candidates.length === 0 && step.enabled && step.status !== 'off' && step.status !== 'done'
                            ? `machineGuard.ladder.${step.rung}.empty` : `machineGuard.ladder.${step.rung}.help`)}
                    </Text>
                    {step.candidates.length > 0 ? (
                        <GuardInsetList nested>
                            {step.candidates.map((candidate, index) => (
                                <GuardInsetRow key={candidate.ref} testID={`machine-guard-candidate-${candidate.ref}`} first={index === 0}
                                    leading={<Icon name={CANDIDATE_ICONS[candidate.kind]} size={14} color={theme.colors.text.secondary} />}
                                    label={candidate.label ?? t('session.untitled')} qualifier={candidate.qualifier}
                                    trailing={<GuardInsetFigure tone={candidate.footprintBytes === largest ? 'strong' : 'normal'}>
                                        {formatMachineBytes(candidate.footprintBytes, 'memory')}
                                    </GuardInsetFigure>} />
                            ))}
                        </GuardInsetList>
                    ) : null}
                </View>
            </View>
        </View>
    );
});

const CHIP = 22;

const styles = StyleSheet.create((theme) => ({
    row: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingVertical: theme.space.s12,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    indented: {
        paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx + CHIP + 14,
    },
    lead: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    stepHead: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
    },
    chipSlot: {
        width: CHIP,
        minHeight: CHIP,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chip: {
        width: CHIP,
        height: CHIP,
        borderRadius: CHIP / 2,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chipNext: {
        backgroundColor: theme.colors.text.primary,
        borderColor: theme.colors.text.primary,
    },
    chipDone: {
        backgroundColor: theme.colors.border.default,
        borderColor: 'transparent',
    },
    chipText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    chipTextNext: {
        color: theme.colors.surface.base,
    },
    stepBody: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    stepTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
        minHeight: CHIP,
    },
    stepTitle: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    quietTitle: {
        color: theme.colors.text.secondary,
    },
    // The switch's touch target is taller than the row's title line; it overflows the line, centred,
    // instead of stretching the step.
    stepTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        flexShrink: 0,
        height: CHIP,
    },
    switchSlot: {
        height: CHIP,
        justifyContent: 'center',
    },
    trailing: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    stepHelp: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    summary: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    summaryStrong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    lockRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
    },
    lock: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        flex: 1,
    },
}));
