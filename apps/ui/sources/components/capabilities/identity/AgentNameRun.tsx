import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatAgentNameListParts, type AgentNameListPart } from './agentNameList';

export { formatAgentNameList } from './agentNameList';

const MARK_SIZE_PX = 13;
// Web draws a mark nested in text inline-flex, whose baseline is its empty first box's top, so the mark hung below
// the line; it sits on the text's middle instead. Native already lays an inline view on the line.
const INLINE_MARK = Platform.OS === 'web' ? ({ verticalAlign: 'middle' } as unknown as ViewStyle) : null;

/**
 * "Claude, Codex and OpenCode": each Agent's catalog mark before its name, joined as the reader's language
 * joins a list; never an icon-only strip. Inline text, so it flows inside a sentence ("Available to … on nl2").
 */
export function AgentNameRun(props: Readonly<{
    agentIds: readonly string[];
    machineId?: string | null;
    serverId?: string | null;
    machines?: readonly Readonly<{ machineId: string; agentIds: readonly string[] }>[];
    tone?: 'primary' | 'secondary';
    /**
     * `sentence` joins as the reader's language joins a list, inside a sentence; `legend` is a label line
     * (a reach legend's row): commas only, regular weight and one line that ellipsizes, so a machine's
     * Agents never wrap under its name.
     */
    form?: 'sentence' | 'legend';
    testID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const identities = useAgentCatalogIdentities({ agentIds: props.agentIds, machineId: props.machineId ?? null,
        serverId: props.serverId ?? null, machines: props.machines });
    const legend = props.form === 'legend';
    const parts = React.useMemo(() => {
        const names = identities.map((identity) => identity.entry.title);
        return legend
            ? names.flatMap((_, index): AgentNameListPart[] => index === 0
                ? [{ kind: 'name', index }]
                : [{ kind: 'literal', text: ', ' }, { kind: 'name', index }])
            : formatAgentNameListParts(names);
    }, [identities, legend]);
    if (identities.length === 0) return null;
    const color = props.tone === 'secondary' ? theme.colors.text.secondary : theme.colors.text.primary;
    if (legend) {
        return (
            <Text testID={props.testID} variant="body" numberOfLines={1} ellipsizeMode="tail" style={{ color }}>
                {parts.map((part, position) => {
                    if (part.kind === 'literal') return part.text;
                    const identity = identities[part.index]!;
                    return (
                        <Text key={`${identity.entry.backendTargetKey ?? identity.entry.qualifiedId}:${position}`}>
                            <View style={INLINE_MARK}>
                                <AgentCatalogIdentityIcon entry={identity.entry} machineId={props.machineId ?? null} serverId={props.serverId ?? null}
                                    current={identity.current} size={MARK_SIZE_PX} />
                            </View>
                            {`\u2009${identity.entry.title}`}
                        </Text>
                    );
                })}
            </Text>
        );
    }
    return (
        <Text testID={props.testID}>
            {parts.map((part, position) => {
                if (part.kind === 'literal') return part.text;
                const identity = identities[part.index]!;
                return (
                    <Text key={`${identity.entry.backendTargetKey ?? identity.entry.qualifiedId}:${position}`} style={[styles.name, { color }]}>
                        <View style={INLINE_MARK}>
                            <AgentCatalogIdentityIcon entry={identity.entry} machineId={props.machineId ?? null} serverId={props.serverId ?? null}
                                current={identity.current} size={MARK_SIZE_PX} />
                        </View>
                        {` ${identity.entry.title}`}
                    </Text>
                );
            })}
        </Text>
    );
}

const styles = StyleSheet.create(() => ({
    // A name reads as an identity inside the sentence: one step heavier than the words around it.
    name: { ...Typography.default('semiBold') },
}));
