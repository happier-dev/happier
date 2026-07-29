import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { useVoiceLabTokens } from './voiceLabTokens';
import type { VoiceLabSurface } from './conceptTypes';

/**
 * Concepts are judged inside the surrounding product, never on a blank canvas.
 *
 * These frames are deliberately dumb reproductions of the real hosts — a sidebar
 * head plus session rows, a transcript above a composer, a phone with safe areas
 * — because the question being answered is "does this belong here", and that
 * question cannot be answered against an empty rectangle.
 */

const ROWS: readonly Readonly<{ project: string; title: string; age: string; dot: 'green' | 'red' | null }>[] = [
    { project: 'HAPPIER-CODEX-DEV-LIVE-R1', title: 'Voice sidebar redesign', age: '2m', dot: 'green' },
    { project: 'HAPPIER-GROK-FORK-R16', title: 'GROK_FRESH_FORK_R16_ALPHA', age: '9h', dot: null },
    { project: 'HAPPIER-DEV-QA-20260727', title: 'Codex rollback QA r1', age: '19h', dot: 'red' },
    { project: 'HAPPIER-GROK-LIVE-R11', title: 'Create child-latest.txt R11', age: '19h', dot: 'green' },
];

const SidebarChrome = React.memo(function SidebarChrome() {
    const { theme } = useUnistyles();
    const tokens = useVoiceLabTokens();
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                paddingHorizontal: 14,
                paddingTop: 14,
                paddingBottom: 12,
            }}
        >
            <View
                style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    backgroundColor: theme.colors.text.primary,
                }}
            />
            <View style={{ flex: 1 }}>
                <Text style={{ ...Typography.default('semiBold'), fontSize: 15, color: tokens.ink }}>Happier</Text>
                <Text style={{ ...Typography.default(), fontSize: 10.5, color: theme.colors.status.connected }}>
                    ● localhost:53288
                </Text>
            </View>
        </View>
    );
});

const SessionRows = React.memo(function SessionRows() {
    const { theme } = useUnistyles();
    const tokens = useVoiceLabTokens();
    return (
        <View style={{ paddingTop: 12 }}>
            <Text
                style={{
                    ...Typography.eyebrow(),
                    color: tokens.inkFaint,
                    paddingHorizontal: 14,
                    paddingBottom: 8,
                }}
            >
                Active
            </Text>
            {ROWS.map((row) => (
                <View key={row.project} style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
                    <Text
                        numberOfLines={1}
                        style={{
                            ...Typography.default('semiBold'),
                            fontSize: 10.5,
                            letterSpacing: 0.4,
                            color: tokens.inkFaint,
                        }}
                    >
                        {row.project}
                    </Text>
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                            marginTop: 5,
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surface.inset,
                        }}
                    >
                        <Text numberOfLines={1} style={{ ...Typography.rowTitle(), color: tokens.ink, flex: 1 }}>
                            {row.title}
                        </Text>
                        {row.dot ? (
                            <View
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 6,
                                    backgroundColor:
                                        row.dot === 'green' ? theme.colors.status.connected : theme.colors.status.error,
                                }}
                            />
                        ) : null}
                        <Text style={{ ...Typography.timestamp(), color: tokens.inkFaint }}>{row.age}</Text>
                    </View>
                </View>
            ))}
        </View>
    );
});

const TranscriptChrome = React.memo(function TranscriptChrome() {
    const tokens = useVoiceLabTokens();
    const lines = [
        { who: 'You', text: 'Take the mic badge — it reads as muted at rest.' },
        { who: 'Codex', text: 'Replacing the slashed glyph with a resting state in VoiceSurfaceHeader.tsx.' },
    ];
    return (
        <View style={{ padding: 14, gap: 12 }}>
            {lines.map((l) => (
                <View key={l.who} style={{ gap: 3 }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 11, color: tokens.inkFaint }}>
                        {l.who}
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 13.5, lineHeight: 19, color: tokens.ink }}>
                        {l.text}
                    </Text>
                </View>
            ))}
        </View>
    );
});

export const ConceptStage = React.memo(function ConceptStage(props: Readonly<{
    surface: VoiceLabSurface;
    /** Where the concept mounts: inline in the flow, or as a floating overlay layer. */
    placement: 'inline' | 'overlay';
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const tokens = useVoiceLabTokens();

    if (props.surface === 'mobile') {
        return (
            <View
                style={{
                    width: 320,
                    height: 520,
                    borderRadius: 34,
                    overflow: 'hidden',
                    borderWidth: 6,
                    borderColor: tokens.dark ? '#0B0B0F' : '#1C1A1A',
                    backgroundColor: theme.colors.surface.base,
                    boxShadow: '0 30px 70px -24px rgba(0,0,0,0.45)',
                } as any}
            >
                {/* Status bar / safe area. */}
                <View style={{ height: 30, alignItems: 'center', justifyContent: 'center' }}>
                    <View
                        style={{
                            width: 88,
                            height: 20,
                            borderRadius: 20,
                            backgroundColor: tokens.dark ? '#0B0B0F' : '#1C1A1A',
                        }}
                    />
                </View>
                <SidebarChrome />
                {props.placement === 'inline' ? props.children : null}
                <View style={{ flex: 1 }}>
                    <SessionRows />
                </View>
                {/* Home indicator. */}
                <View style={{ height: 22, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 110, height: 4, borderRadius: 4, backgroundColor: tokens.rule }} />
                </View>
                {props.placement === 'overlay' ? (
                    <View style={{ position: 'absolute', inset: 0 }} pointerEvents="box-none">
                        {props.children}
                    </View>
                ) : null}
            </View>
        );
    }

    if (props.surface === 'home') {
        // Voice Home = the same presence, given room, plus the identity block
        // the sidebar has no width for. Nothing else here is new — which is
        // itself the finding.
        return (
            <View
                style={{
                    width: 560,
                    height: 470,
                    borderRadius: 14,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: tokens.rule,
                    backgroundColor: theme.colors.surface.base,
                    boxShadow: '0 20px 52px -26px rgba(0,0,0,0.35)',
                } as any}
            >
                <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, gap: 10 }}>
                    <Text
                        style={{
                            ...Typography.default('semiBold'),
                            fontSize: 24,
                            letterSpacing: -0.6,
                            color: tokens.ink,
                        }}
                    >
                        Voice
                    </Text>
                    {/* Which agent, which account, which machine — the one thing a
                        dedicated Home can say that a 288pt sidebar band cannot. */}
                    <View style={{ flexDirection: 'row', gap: 22, flexWrap: 'wrap' }}>
                        {[
                            { k: 'Agent', v: 'Codex' },
                            { k: 'Account', v: 'ai@batiplus.ch' },
                            { k: 'Machine', v: 'leeroy-mbp' },
                            { k: 'Session', v: 'happier/dev' },
                        ].map((item) => (
                            <View key={item.k} style={{ gap: 1 }}>
                                <Text style={{ ...Typography.eyebrow(), color: tokens.inkFaint }}>{item.k}</Text>
                                <Text
                                    style={{
                                        ...Typography.default('semiBold'),
                                        fontSize: 13,
                                        color: tokens.ink,
                                    }}
                                >
                                    {item.v}
                                </Text>
                            </View>
                        ))}
                    </View>
                </View>
                <View style={{ height: 1, backgroundColor: tokens.rule }} />
                {props.placement === 'inline' ? (
                    props.children
                ) : (
                    <View style={{ flex: 1 }} pointerEvents="box-none">
                        {props.children}
                    </View>
                )}
            </View>
        );
    }

    if (props.surface === 'session') {
        return (
            <View
                style={{
                    width: 520,
                    height: 470,
                    borderRadius: 14,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: tokens.rule,
                    backgroundColor: theme.colors.surface.base,
                    boxShadow: '0 20px 52px -26px rgba(0,0,0,0.35)',
                } as any}
            >
                <View
                    style={{
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        borderBottomWidth: 1,
                        borderBottomColor: tokens.rule,
                    }}
                >
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: tokens.ink }}>
                        Voice sidebar redesign
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 11, color: tokens.inkFaint }}>
                        happier/dev · leeroy-mbp
                    </Text>
                </View>
                {props.placement === 'inline' ? (
                    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                        <View style={{ flex: 1 }}>
                            <TranscriptChrome />
                        </View>
                        {props.children}
                    </View>
                ) : (
                    <View style={{ flex: 1 }}>
                        <TranscriptChrome />
                        <View style={{ position: 'absolute', inset: 0 }} pointerEvents="box-none">
                            {props.children}
                        </View>
                    </View>
                )}
            </View>
        );
    }

    // Sidebar: the real 320pt column, in its real neighbourhood.
    return (
        <View
            style={{
                width: 320,
                height: 470,
                borderRadius: 14,
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: tokens.rule,
                backgroundColor: theme.colors.surface.base,
                boxShadow: '0 20px 52px -26px rgba(0,0,0,0.35)',
            } as any}
        >
            <SidebarChrome />
            {props.placement === 'inline' ? props.children : null}
            <View style={{ flex: 1 }}>
                <SessionRows />
            </View>
            {props.placement === 'overlay' ? (
                <View style={{ position: 'absolute', inset: 0 }} pointerEvents="box-none">
                    {props.children}
                </View>
            ) : null}
        </View>
    );
});
