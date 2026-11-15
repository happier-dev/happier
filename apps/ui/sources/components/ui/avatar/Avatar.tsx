import * as React from "react";
import { View } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveHappierBrandFallback } from '@happier-dev/plugin-ui/presentation';
import { AvatarSkia } from "./AvatarSkia";
import { AvatarGradient } from "./AvatarGradient";
import { AvatarBrutalist } from "./AvatarBrutalist";
import { AvatarPlanet } from './AvatarPlanet';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';
import {
    resolveAgentIdFromFlavor,
    getAgentAvatarOverlaySizes,
    hasAgentIconMark,
} from '@/agents/catalog/catalog';

interface AvatarProps {
    id: string;
    testID?: string;
    accessibilityLabel?: string;
    title?: boolean;
    /**
     * The name a monogram letter comes from while `id` keeps seeding the artwork (a Team: its name
     * names it, its immutable id colours it, so two Teams sharing a name still differ).
     */
    monogram?: string | null;
    /** A mark rather than a face: a square with the theme's mark radius (Teams). */
    square?: boolean;
    size?: number;
    monochrome?: boolean;
    flavor?: string | null;
    imageUrl?: string | null;
    thumbhash?: string | null;
    hasUnreadMessages?: boolean;
    unreadBadgeTestID?: string;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    monogram: {
        position: 'absolute',
        inset: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    monogramText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        textShadowColor: theme.colors.surface.base,
        textShadowRadius: 2,
        textShadowOffset: { width: 0, height: 0 },
    },
    flavorIcon: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 100,
        padding: theme.space.s2,
        ...shadowLevelStyle(theme.colors.shadowLevels[2]),
    },
    unreadBadge: {
        position: 'absolute',
        top: -2,
        right: -2,
        backgroundColor: theme.colors.text.link,
        borderRadius: 100,
        borderWidth: 1.5,
        borderColor: theme.colors.surface.base,
    },
}));

/** Marks at control height and above take the control radius; smaller ones the small-mark radius. */
const SQUARE_MARK_CONTROL_SIZE = 28;

export const Avatar = React.memo((props: AvatarProps) => {
    const { flavor, size = 48, imageUrl, thumbhash, hasUnreadMessages, unreadBadgeTestID, testID, accessibilityLabel, monogram, ...avatarProps } = props;
    const { theme } = useUnistyles();
    const imageLabel = accessibilityLabel || (props.title ? props.id : undefined);
    const imageAccessibility = { accessible: Boolean(imageLabel), accessibilityRole: imageLabel ? 'image' as const : undefined, accessibilityLabel: imageLabel };
    // A square mark is clipped to the theme's own radius step, so it nests with rows and sheets
    // instead of drawing hard corners (DESIGN.md: radii derive from one base).
    const squareRadius = theme.borderRadius[size >= SQUARE_MARK_CONTROL_SIZE ? 'md' : 'sm'];
    const avatarStyle = useSetting('avatarStyle');
    const showFlavorIcons = useSetting('showFlavorIcons');

    const agentId = resolveAgentIdFromFlavor(flavor);
    // An Agent the catalog carries no presentation for — an installed Agent, a session whose Agent is
    // unreadable, or a bundled Agent with no mark of its own (Muse) — has no mark to show. Wearing the
    // default Agent's mark would claim the session belongs to that Agent, and an empty badge is a blank
    // disc over the avatar, so it stays bare.
    const overlayAgentId = showFlavorIcons && agentId && hasAgentIconMark(agentId, theme) ? agentId : null;

    const unreadBadgeSize = Math.round(size * 0.4);
    const unreadBadgeElement = hasUnreadMessages ? (
        <View
            testID={unreadBadgeTestID}
            style={[styles.unreadBadge, { width: unreadBadgeSize, height: unreadBadgeSize }]}
        />
    ) : null;

    // Render custom image if provided
    if (imageUrl) {
        const imageElement = (
            <SafeExpoImage
                source={{ uri: imageUrl, thumbhash: thumbhash || undefined }}
                placeholder={thumbhash ? { thumbhash: thumbhash } : undefined}
                contentFit="cover"
                style={{
                    width: size,
                    height: size,
                    borderRadius: avatarProps.square ? squareRadius : size / 2,
                }}
            />
        );

        if (overlayAgentId || hasUnreadMessages) {
            const { circleSize, iconSize } = getAgentAvatarOverlaySizes(overlayAgentId ?? '', size);

            return (
                <View testID={testID} {...imageAccessibility} style={[styles.container, { width: size, height: size }]}>
                    {imageElement}
                    {overlayAgentId && (
                        <View style={[styles.flavorIcon, {
                            width: circleSize,
                            height: circleSize,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }]}>
                            <AgentIcon agentId={overlayAgentId} size={iconSize} />
                        </View>
                    )}
                    {unreadBadgeElement}
                </View>
            );
        }

        return testID || accessibilityLabel || props.title ? (
            <View testID={testID} {...imageAccessibility}>
                {imageElement}
            </View>
        ) : imageElement;
    }

    // Original generated avatar logic
    // Determine which avatar variant to render
    const generated = avatarStyle === 'pixelated' ? <AvatarSkia {...avatarProps} size={size} />
        : avatarStyle === 'brutalist' ? <AvatarBrutalist {...avatarProps} size={size} />
            : avatarStyle === 'planet' ? <AvatarPlanet id={avatarProps.id} size={size} monochrome={avatarProps.monochrome} />
                : <AvatarGradient {...avatarProps} size={size} />;
    const artwork = avatarProps.square
        ? <View style={{ width: size, height: size, borderRadius: squareRadius, overflow: 'hidden' }}>{generated}</View>
        : generated;
    const monogramName = monogram?.trim();
    const firstGrapheme = monogramName ? resolveHappierBrandFallback(monogramName)
        : props.title ? resolveHappierBrandFallback(props.id) : undefined;

    const { circleSize, iconSize } = getAgentAvatarOverlaySizes(overlayAgentId ?? '', size);

    if (overlayAgentId || hasUnreadMessages || firstGrapheme || testID || accessibilityLabel) {
        return (
            <View testID={testID} {...imageAccessibility} style={[styles.container, { width: size, height: size }]}>
                {artwork}
                {firstGrapheme ? <View style={styles.monogram} pointerEvents="none" accessible={false}>
                    <Text testID="avatar-monogram" style={[styles.monogramText, { fontSize: size * 0.45, lineHeight: size * 0.6 }]}>{firstGrapheme}</Text>
                </View> : null}
                {overlayAgentId && (
                    <View style={[styles.flavorIcon, {
                        width: circleSize,
                        height: circleSize,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }]}>
                        <AgentIcon agentId={overlayAgentId} size={iconSize} />
                    </View>
                )}
                {unreadBadgeElement}
            </View>
        );
    }

    // Return avatar without wrapper when not showing flavor icons
    return artwork;
});
