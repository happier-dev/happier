import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { NewSessionScreen } from '@/components/sessions/new/NewSessionScreen';
import { NewSessionEmbeddedHostProvider } from '@/components/sessions/new/navigation/newSessionHost';
import { useNewSessionEmbeddedHostState } from '@/components/sessions/new/navigation/useNewSessionEmbeddedHostState';
import { useNewSessionShellHost } from '@/components/sessions/new/navigation/newSessionEntry';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { getDemoModeServerId, isSeededDemoHome } from '@/demoMode/runtime/enterExitDemoMode';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

import { HubComposerSuggestions, type HomeComposerSuggestionFill } from './suggestions/HubComposerSuggestions';

/**
 * Home's "Start a session": the real New Session composer (the same surface and model as `/new`,
 * embedded through `NewSessionEmbeddedHostProvider`) at the page column's width, with suggestions
 * under it that fill it.
 *
 * Home starts on the ordinary-entry draft, the one "+" opens, so a draft begun in either place
 * continues in the other. Typing and Enter start the session here; the app then opens it, and the
 * next time Home is shown it holds a fresh draft.
 *
 * The composer's chips issue no machine RPCs until the person shows intent (focus, hover, touch or
 * a suggestion); until then they show cached state.
 */
/**
 * How the suggestions stand: `tiles` on the plain page; under Home's atmosphere they step back to links or
 * pills, wherever the composer sits; `none` while no machine exists, when no suggestion could run yet (58d AF1).
 * Home decides this once for both of its paths.
 */
export type HubComposerSuggestionsPresentation = 'tiles' | 'links' | 'pills' | 'none';

type HubComposerSectionProps = Readonly<{
    suggestions: HubComposerSuggestionsPresentation;
    /**
     * `hero`: under Home's atmosphere the composer stands in the hero's own column (it supplies the
     * width and rhythm). Refs let the hero measure it.
     */
    hero?: Readonly<{
        composerRef: React.Ref<View>;
        suggestionsRef: React.Ref<View>;
        onLayout: () => void;
    }>;
}>;

export const HubComposerSection = React.memo(function HubComposerSection(props: HubComposerSectionProps) {
    const destinationVisible = useDestinationVisibility();
    const screenFocused = useOptionalScreenIsFocused();
    const docked = useNewSessionShellHost()?.visible === true;
    // Measured while the composer stands here, so the place it leaves keeps its height.
    const composerHeight = React.useRef<number | undefined>(undefined);
    // Home shares the ordinary draft with /new. A retained pane releases its composer, including its local
    // attachment controller, before the visible route takes that draft; the dock takes it through `docked`.
    // A page that only covers Home's screen (Settings, a Session) takes no draft: the composer stays mounted
    // and hidden, its effects withdrawn, so a return neither rebuilds it nor re-asks what it already holds.
    if (!destinationVisible) return null;
    return (
        <React.Activity mode={screenFocused ? 'visible' : 'hidden'}>
            {docked
                ? <HubComposerHeld {...props} height={composerHeight.current} />
                : <HubComposerSectionContent {...props} composerHeight={composerHeight} />}
        </React.Activity>
    );
});

type HubComposerFill = (suggestion: HomeComposerSuggestionFill) => void;

/** The draft's params for a suggestion: an explicit fill that replaces what is typed, never a send. */
function suggestionParams(suggestion: HomeComposerSuggestionFill) {
    return {
        prompt: suggestion.prompt,
        ...(suggestion.placement
            ? {
                spawnServerId: suggestion.placement.serverId ?? undefined,
                machineId: suggestion.placement.machineId,
                directory: suggestion.placement.directory,
            }
            : {}),
    };
}

/** The composer's place under Home's greeting, with the suggestions that fill it. */
function HubComposerStack(props: HubComposerSectionProps & Readonly<{ composer: React.ReactNode; onFill: HubComposerFill }>) {
    const presentation = props.suggestions === 'none' ? null : props.suggestions;
    const hero = props.hero;
    if (hero) {
        return (
            <View testID="hub-composer" style={styles.heroStack}>
                {props.composer}
                {presentation ? (
                    <View ref={hero.suggestionsRef} onLayout={hero.onLayout}>
                        <HubComposerSuggestions onFill={props.onFill} presentation={presentation} />
                    </View>
                ) : null}
            </View>
        );
    }
    return (
        // The composer reserves its status line above the card (launch blockers and progress say themselves
        // there without moving it): that row is the room above this section, so it adds no section gap of its own.
        <ItemGroup surface="none" header="none">
            <View testID="hub-composer" style={presentation === 'tiles' ? styles.stack : styles.heroStack}>
                {props.composer}
                {presentation ? <HubComposerSuggestions onFill={props.onFill} presentation={presentation} /> : null}
            </View>
        </ItemGroup>
    );
}

/**
 * While the draft is docked, Home's composer holds its place as a quiet line pointing at it: one draft, one
 * editor. Pressing it, or a suggestion, goes to the dock.
 */
function HubComposerHeld(props: HubComposerSectionProps & Readonly<{ height: number | undefined }>) {
    const { theme } = useUnistyles();
    const shell = useNewSessionShellHost()!;
    const { open, host: { setParams } } = shell;
    const fill = React.useCallback((suggestion: HomeComposerSuggestionFill) => {
        setParams(suggestionParams(suggestion));
        open();
    }, [open, setParams]);
    return <HubComposerStack {...props} onFill={fill} composer={(
        <Pressable ref={props.hero?.composerRef} onLayout={props.hero?.onLayout} testID="hub-composer-held" accessibilityRole="button" onPress={() => open()}>
            <GlassSurface surfaceGroup="card" finishRole="composer" style={[styles.held, { height: props.height }]}>
                <Text variant="body" style={{ color: theme.colors.text.secondary }}>{t('homeComposer.draftOpenBelow')}</Text>
            </GlassSurface>
        </Pressable>
    )} />;
}

function HubComposerSectionContent(props: HubComposerSectionProps & Readonly<{ composerHeight: React.MutableRefObject<number | undefined> }>) {
    const { host, markDemanded } = useNewSessionEmbeddedHostState();
    const server = useActiveServerSnapshot(getDemoModeServerId() !== null);
    const demoPreview = isSeededDemoHome(server.serverId);
    // A local showcase has no launch credentials. Keep the real draft and admission, while its
    // empty presentation stays neutral rather than claiming this known demo machine is offline.
    const presentedHost = React.useMemo(() => demoPreview ? {
        ...host,
        emptyComposerStatus: null,
    } : host, [demoPreview, host]);
    const draftId = typeof host.params.draftId === 'string' ? host.params.draftId : 'home-composer';
    const setHostParams = host.setParams;

    const fill = React.useCallback((suggestion: HomeComposerSuggestionFill) => {
        markDemanded();
        setHostParams(suggestionParams(suggestion));
    }, [markDemanded, setHostParams]);

    const hero = props.hero;
    const composer = (
        <View
            ref={hero?.composerRef}
            onLayout={(event) => {
                props.composerHeight.current = event.nativeEvent.layout.height;
                hero?.onLayout();
            }}
            testID="hub-composer.intent"
            onFocus={markDemanded}
            onPointerEnter={markDemanded}
            onTouchStart={markDemanded}
        >
            <NewSessionEmbeddedHostProvider host={presentedHost}>
                <ComposerBannerCollapseProvider key={draftId}>
                    <NewSessionScreen presentation="embedded" composerControlPreset={demoPreview ? 'compact' : undefined} />
                </ComposerBannerCollapseProvider>
            </NewSessionEmbeddedHostProvider>
        </View>
    );
    return <HubComposerStack {...props} composer={composer} onFill={fill} />;
}

const styles = StyleSheet.create((theme) => ({
    stack: {
        gap: 10,
    },
    held: {
        justifyContent: 'flex-start',
        padding: theme.space.s16,
        borderRadius: theme.parts.composer.radius,
    },
    // Lab `at-links`: the suggestions sit 12 px under the composer.
    heroStack: {
        gap: 12,
    },
}));
