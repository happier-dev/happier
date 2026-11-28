import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SupporterThanks } from '@/components/plans/offer/SupporterThanks';
import { formatSupporterNumber } from '@/components/plans/planSurfaceCopy';
import type { SupporterPassIdentity } from '@/components/plans/pass/SupporterPass';
import { showKeepOrLetGoPreview, type KeepOrLetGoPreview } from '@/components/sessions/keepOrLetGo/KeepOrLetGoSheet';
import { formatLeavingDate } from '@/components/sessions/keepOrLetGo/keepOrLetGoCopy';
import { StarAskCard, type StarAskPresentation } from '@/components/sessions/shell/view/StarAskCard';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * Settings › Developer › Preview Plans & Prompts: one press opens each plans nudge or sheet as a
 * person would meet it, so its look and motion can be checked live without env flags, timers or a
 * real purchase. Every preview is inert: nothing is read from or written to the server, and the
 * section renders nothing outside Developer Mode.
 */

const DAY_MS = 86_400_000;
/** The thank-you's pass turns over shortly after opening, as when the number arrives from checkout. */
const THANKS_NUMBER_ARRIVES_MS = 700;
const PREVIEW_SUPPORTER_NUMBER = 42;
/** A star press settles after a beat, like the GitHub round trip. */
const STAR_SETTLES_MS = 900;

function keepOrLetGoSample(): KeepOrLetGoPreview {
    const nowMs = Date.now();
    const lastActive = (daysAgo: number) => t('keepOrLetGo.cardLastActive', { date: formatLeavingDate(nowMs - daysAgo * DAY_MS, nowMs) });
    return {
        retentionDays: 60,
        sessions: [
            { id: 'preview-relay', title: 'Fix the relay reconnect after sleep', subtitle: `studio-mac · ${lastActive(57)}`, leavesAt: nowMs + 3 * DAY_MS },
            { id: 'preview-notes', title: 'Draft the 0.2 release notes', subtitle: `devbox · ${lastActive(56)}`, leavesAt: nowMs + 4 * DAY_MS },
            { id: 'preview-migration', title: 'Migrate settings to the new registry', subtitle: `studio-mac · ${lastActive(55)}`, leavesAt: nowMs + 5 * DAY_MS },
            { id: 'preview-flaky', title: 'Investigate the flaky handoff test', subtitle: lastActive(54), leavesAt: nowMs + 6 * DAY_MS },
        ],
    };
}

function StarAskPreviewSheet(props: CustomModalInjectedProps & Readonly<{ presentation: StarAskPresentation }>) {
    const [state, setState] = React.useState<'ready' | 'pending' | 'done'>('ready');
    const { onClose, presentation } = props;
    const chrome = React.useMemo(() => ({ kind: 'card' as const, header: 'floatingClose' as const, title: 'Preview', testID: 'dev-preview-star-ask-sheet' }), []);
    useModalCardChrome(props.setChrome, chrome);
    React.useEffect(() => {
        if (state !== 'pending') return undefined;
        const settle = setTimeout(() => setState('done'), STAR_SETTLES_MS);
        return () => clearTimeout(settle);
    }, [state]);
    return (
        <View style={styles.previewBody}>
            <StarAskCard
                presentation={presentation}
                state={state}
                // The supporter prompt's action leads to the plans page; the preview stops at the card.
                primary={() => (presentation.kind === 'star' ? setState('pending') : onClose())}
                dismiss={onClose}
                onThanksFinished={onClose}
            />
        </View>
    );
}

function SupporterThanksPreviewSheet(props: CustomModalInjectedProps) {
    const firstName = storage((state) => state.profile.firstName);
    const [identity, setIdentity] = React.useState<SupporterPassIdentity | null>(null);
    const [ring, setRing] = React.useState(true);
    React.useEffect(() => {
        const arrive = setTimeout(() => setIdentity({ number: PREVIEW_SUPPORTER_NUMBER, name: firstName ?? null, sinceMs: Date.now() }), THANKS_NUMBER_ARRIVES_MS);
        return () => clearTimeout(arrive);
    }, [firstName]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('planSurface.thanksTitle'),
        subtitle: t('planSurface.thanksBody', { number: formatSupporterNumber(PREVIEW_SUPPORTER_NUMBER) }),
        testID: 'dev-preview-supporter-thanks-sheet',
        bodyScroll: 'auto' as const,
        dimensions: { width: 700, maxHeightRatio: 0.9, size: 'dialog' as const },
    }), []);
    useModalCardChrome(props.setChrome, chrome);
    return <SupporterThanks identity={identity} ring={ring} onRingChange={setRing} error={null} onDone={props.onClose} />;
}

export function PlansPromptsPreviewDevSection() {
    const { theme } = useUnistyles();
    const devModeEnabled = useLocalSetting('devModeEnabled');
    if (!devModeEnabled) return null;
    const icon = (name: 'star' | 'heart' | 'clock' | 'medal') => <Icon name={name} size={24} color={theme.colors.supporter.accent} />;
    return (
        <ItemGroup title="Preview Plans & Prompts" footer="Opens each nudge and sheet with sample data. Nothing is read from or written to the server.">
            <Item
                testID="dev-preview-star-ask"
                title="Preview Star Ask"
                subtitle="The session card asking for a GitHub star"
                icon={icon('star')}
                onPress={() => Modal.show({ component: StarAskPreviewSheet, props: { presentation: { kind: 'star', count: 4218, login: 'octocat' } } })}
            />
            <Item
                testID="dev-preview-supporter-prompt"
                title="Preview Supporter Prompt"
                subtitle={t('supporterAsk.supportTitle')}
                icon={icon('heart')}
                onPress={() => Modal.show({ component: StarAskPreviewSheet, props: { presentation: { kind: 'supporter_prompt' } } })}
            />
            <Item
                testID="dev-preview-keep-or-let-go"
                title="Preview Keep or Let Go"
                subtitle="Four sample sessions leaving Happier Cloud"
                icon={icon('clock')}
                onPress={() => showKeepOrLetGoPreview(keepOrLetGoSample())}
            />
            <Item
                testID="dev-preview-supporter-thanks"
                title="Preview Thank-You Pass Flip"
                subtitle={`Supporter No. ${formatSupporterNumber(PREVIEW_SUPPORTER_NUMBER)} and the ring switch`}
                icon={icon('medal')}
                onPress={() => Modal.show({ component: SupporterThanksPreviewSheet })}
            />
        </ItemGroup>
    );
}

const styles = StyleSheet.create(() => ({
    // Room for the floating close above the card.
    previewBody: {
        paddingHorizontal: 16,
        paddingTop: 48,
        paddingBottom: 16,
    },
}));
