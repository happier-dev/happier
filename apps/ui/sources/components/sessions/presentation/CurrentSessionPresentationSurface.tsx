import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CurrentSessionPresentationStateV1Schema,
    currentSessionPresentationEntryIdentityV1,
} from '@happier-dev/protocol/sessions';
import type { PluginProjectedComposerRegionEntryV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { recordSessionPayloadConsumptionTelemetry } from '@/sync/domains/session/sessionPayloadConsumptionTelemetry';
import type { Session } from '@/sync/domains/state/storageTypes';

const stylesheet = StyleSheet.create((theme) => ({
    group: {
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    transientLines: {
        gap: 6,
    },
    item: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 17,
    },
}));

export const CurrentSessionPresentationSurface = React.memo(function CurrentSessionPresentationSurface(props: Readonly<{
    session: Pick<Session, 'agentState'>;
    placement: 'beforeComposer' | 'afterComposer';
    /**
     * SessionView supplies the one normalized manifest catalog. These entries
     * remain independent from transient Presentation state even though this
     * incumbent component owns their shared physical before/after slot.
     */
    composerRegions?: readonly PluginProjectedComposerRegionEntryV1[];
    /**
     * The composition owner creates the exact Composer mount and delegates it
     * to PluginSurfaceHost. This physical slot never selects renderers or
     * creates a second loader, Resource, crash, or Host API owner.
     */
    renderComposerRegion?: (region: PluginProjectedComposerRegionEntryV1) => React.ReactNode;
}>) {
    const styles = stylesheet;
    const raw = (props.session.agentState as Record<string, unknown> | null)?.[
        CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY
    ];
    const parsed = CurrentSessionPresentationStateV1Schema.safeParse(raw);
    // Transient Presentation and manifest regions have independent producers
    // and deletion/generation lifecycles. A missing or invalid transient
    // record therefore withholds only transient chrome; it cannot suppress an
    // otherwise admitted manifest Composer region in this shared slot.
    const presentation = parsed.success ? parsed.data : null;
    if (presentation && props.placement === 'beforeComposer') {
        recordSessionPayloadConsumptionTelemetry({
            family: 'presentation',
            payload: presentation,
            itemCount: presentation.statuses.length + presentation.widgets.length,
            lineCount: presentation.statuses.length
                + presentation.widgets.reduce((sum, widget) => sum + widget.lines.length, 0),
        });
    }

    const lines = !presentation
        ? []
        : props.placement === 'beforeComposer'
        ? [
            ...presentation.statuses.map((status) => ({
                key: `status:${currentSessionPresentationEntryIdentityV1(status.owner, status.localKey)}`,
                lines: [status.text],
            })),
            ...presentation.widgets
                .filter((widget) => widget.placement === 'beforeComposer')
                .map((widget) => ({
                    key: `widget:${currentSessionPresentationEntryIdentityV1(widget.owner, widget.localKey)}`,
                    lines: widget.lines,
                })),
        ]
        : presentation.widgets
            .filter((widget) => widget.placement === 'afterComposer')
            .map((widget) => ({
                key: `widget:${currentSessionPresentationEntryIdentityV1(widget.owner, widget.localKey)}`,
                lines: widget.lines,
            }));
    // Preserve normalized catalog order verbatim. Manifest regions do not use
    // Presentation's keyed delete lifecycle and are therefore never folded
    // into `lines` or its telemetry payload.
    const composerRegions = (props.composerRegions ?? []).filter((region) => (
        region.definition.placement === props.placement
    ));
    if (lines.length === 0 && composerRegions.length === 0) return null;

    return (
        <View
            style={styles.group}
            testID={`current-session-presentation-${props.placement}`}
        >
            {lines.length > 0 ? (
                <View style={styles.transientLines} accessibilityLiveRegion="polite">
                    {lines.map((item) => (
                        <View key={item.key} style={styles.item}>
                            {item.lines.map((line, index) => (
                                <Text key={`${item.key}:${index}`} style={styles.text}>{line}</Text>
                            ))}
                        </View>
                    ))}
                </View>
            ) : null}
            {props.renderComposerRegion ? composerRegions.map((region) => (
                <React.Fragment key={`composer-region:${region.id}:${region.immutableGenerationId}`}>
                    {props.renderComposerRegion!(region)}
                </React.Fragment>
            )) : null}
        </View>
    );
});
