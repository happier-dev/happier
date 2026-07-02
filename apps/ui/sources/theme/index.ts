import { Platform } from 'react-native';
import {
    buildDarkShadowLevels,
    buildLightShadowLevels,
    buildShadowPopoverArrowBoxShadow,
} from '../shadowElevation';
import { createVerticalGradient } from './verticalGradient';

// Shared spacing, sizing constants (DRY - used by both themes)
const sharedSpacing = {
    // Spacing scale (based on actual usage patterns in codebase)
    margins: {
        xs: 4,   // Tight spacing, status indicators
        sm: 8,   // Small gaps, most common gap value
        md: 12,  // Button gaps, card margins
        lg: 16,  // Most common padding value
        xl: 20,  // Large padding
        xxl: 24, // Section spacing
    },

    // Border radii (based on actual usage patterns in codebase)
    borderRadius: {
        sm: 4,   // Checkboxes (20x20 boxes use 4px corners)
        md: 8,   // Buttons, items (most common - 31 uses)
        lg: 10,  // Input fields (matches "new session panel input fields")
        xl: 12,  // Cards, containers (20 uses)
        xxl: 16, // Main containers
        modalCard: 14, // Modal card surfaces (wizard shell, story deck)
    },

    // Icon sizes (based on actual usage patterns)
    iconSize: {
        small: 12,  // Inline icons (checkmark, lock, status indicators)
        medium: 16, // Section headers, add buttons
        large: 20,  // Action buttons (delete, duplicate, edit) - most common
        xlarge: 24, // Main section icons (desktop, folder)
    },
} as const;

export const lightTheme = {
    dark: false,
    colors: {

        //
        // Main colors
        //

        text: {
            primary: '#000000',
            secondary: '#6c6c70',
            tertiary: '#99999d',
            link: '#2BACCC',
            destructive: '#FF3B30',
            placeholder: '#999999',
            disabled: '#C0C0C0',
        },
        accent: {
            blue: '#007AFF',
            green: '#34C759',
            orange: '#FF9500',
            yellow: '#FFCC00',
            red: '#FF3B30',
            indigo: Platform.select({ ios: '#5856D6', default: '#5C6BC0' }),
            purple: Platform.select({ ios: '#AF52DE', default: '#9C27B0' }),
        },
        state: {
            success: {
                foreground: '#34C759',
                background: 'rgba(52, 199, 89, 0.12)',
                border: '#34C759',
            },
            warning: {
                foreground: '#FF9500',
                background: '#FFF8F0',
                border: '#FF9500',
            },
            danger: {
                foreground: '#FF3B30',
                background: '#FFF0F0',
                border: '#FF3B30',
            },
            info: {
                foreground: Platform.select({ ios: '#5856D6', default: '#5C6BC0' }),
                background: 'rgba(0, 122, 255, 0.10)',
                border: '#007AFF',
            },
            neutral: {
                foreground: '#8E8E93',
                background: '#F2F2F7',
                border: '#D1D1D6',
            },
            active: {
                foreground: '#007AFF',
                background: 'rgba(0, 122, 255, 0.10)',
                border: 'rgba(0, 122, 255, 0.40)',
            },
        },
        background: {
            canvas: '#F5F5F5',
        },
        surface: {
            base: '#ffffff',
            inset: '#F8F8F8',
            elevated: '#f0f0f0',
            ripple: 'rgba(0, 0, 0, 0.08)',
            pressed: '#fafafa',
            selected: '#f8f8f8',
            pressedOverlay: '#fafafa',
        },
        border: {
            default: Platform.select({ ios: '#eaeaea', default: '#eaeaea' }),
            surface: 'transparent',
            strong: Platform.select({ ios: '#d6d6d6', default: '#d6d6d6' }),
            modal: 'rgba(0, 0, 0, 0.1)',
        },
        effect: {
            surfaceHighlight: 'transparent',
        },
        chrome: {
            header: {
                background: '#ffffff',
                foreground: '#18171C',
            },
        },
        overlay: {
            scrimSoft: 'rgba(0, 0, 0, 0.18)',
            scrim: 'rgba(0, 0, 0, 0.45)',
            scrimStrong: 'rgba(255, 255, 255, 0.68)',
            scrimWizard: 'rgba(255, 255, 255, 0.52)',
            foreground: '#FFFFFF',
            secondaryForeground: 'rgba(255, 255, 255, 0.9)',
        },
        desktopPetOverlay: {
            bubble: {
                background: '#FFFFFF',
                backgroundPressed: '#F7F7F7',
                text: '#1C1C1E',
                textSecondary: '#5F6368',
                controlBackground: 'rgba(255, 255, 255, 0.96)',
                controlBackgroundPressed: '#F2F2F7',
            },
        },
        /** Legacy tint helper (`Color(theme.colors.shadow.color)...`); prefer `shadowLevels` for cast shadows. */
        shadow: {
            color: '#000000',
            opacity: 0.1,
        },
        shadowLevels: buildLightShadowLevels(),
        shadowPopoverArrowBoxShadow: buildShadowPopoverArrowBoxShadow(false),

        //
        // System components
        //

        switch: {
            track: {
                active: '#1976D2',
                inactive: '#dddddd',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        fab: {
            background: '#000000',
            backgroundPressed: '#1a1a1a',
            gradient: createVerticalGradient(['#000000', '#171717']),
            icon: '#FFFFFF',
        },
        segmentedControl: {
            trackBackground: '#f0f0f0',
            trackGradient: undefined,
            activeBackground: '#ffffff',
            activeGradient: createVerticalGradient(['#FDFDFD', '#FFFFFF']),
        },
        radio: {
            active: '#007AFF',
            inactive: '#C0C0C0',
            dot: '#007AFF',
        },
        button: {
            primary: {
                background: '#000000',
                gradient: createVerticalGradient(['#000000', '#020202']),
                tint: '#FFFFFF',
                disabled: '#C0C0C0',
            },
            secondary: {
                background: 'transparent',
                tint: '#666666',
            }
        },
        feed: {
            card: {
                background: '#f8f8f8',
            }
        },
        input: {
            background: '#F5F5F5',
            text: '#000000',
            placeholder: '#999999',
        },
        composer: {
            chipTint: '#767676',
        },
        //
        // App components
        //

        status: {
            connected: '#34C759',
            connecting: '#007AFF',
            actionRequired: '#FF9500',
            disconnected: '#999999',
            error: '#FF3B30',
            default: '#8E8E93',
        },

        // Permission mode colors
        permission: {
            default: '#8E8E93',
            acceptEdits: '#007AFF',
            bypass: '#FF9500',
            plan: '#34C759',
            readOnly: '#8B8B8D',
            safeYolo: '#FF6B35',
            yolo: '#DC143C',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#34C759',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF3B30',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#007AFF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#E5E5EA',
                border: '#D1D1D6',
                text: '#8E8E93',
            },
            selected: {
                background: '#F2F2F7',
                border: '#D1D1D6',
                text: '#3C3C43',
            },
        },


        // Diff view
        diff: {
            outline: '#E0E0E0',
            success: '#28A745',
            error: '#DC3545',
            added: {
                background: '#E6FFED',
                border: '#34D058',
                foreground: '#24292E',
            },
            removed: {
                background: '#FFEEF0',
                border: '#D73A49',
                foreground: '#24292E',
            },
            context: {
                background: '#F6F8FA',
                foreground: '#586069',
            },
            lineNumber: {
                background: '#F6F8FA',
                foreground: '#959DA5',
            },
            hunk: {
                background: '#F1F8FF',
                foreground: '#005CC5',
            },
            leadingSpaceDot: '#E8E8E8',
            inlineAdded: {
                background: '#ACFFA6',
                foreground: '#0A3F0A',
            },
            inlineRemoved: {
                background: '#FFCECB',
                foreground: '#5A0A05',
            },
        },

        // Message View colors
        message: {
            user: {
                background: '#f0eee6',
                foreground: '#000000',
            },
            agent: {
                foreground: '#000000',
            },
            event: {
                foreground: '#666666',
            },
        },

        // Code/Syntax colors
        syntax: {
            keyword: '#1d4ed8',
            string: '#059669',
            comment: '#6b7280',
            number: '#0891b2',
            function: '#9333ea',
            bracket1: '#ff6b6b',
            bracket2: '#4ecdc4',
            bracket3: '#45b7d1',
            bracket4: '#f7b731',
            bracket5: '#5f27cd',
            default: '#374151',
        },

        // Git status colors
        versionControl: {
            added: {
                foreground: '#22c55e',
                background: 'rgba(34, 197, 94, 0.12)',
            },
            removed: {
                foreground: '#ef4444',
                background: 'rgba(239, 68, 68, 0.12)',
            },
        },

    },

    ...sharedSpacing,
};

export const darkTheme = {
    dark: true,
    colors: {

        //
        // Main colors
        //

        text: {
            primary: '#EFEFEF',
            secondary: '#8A817C',
            tertiary: '#6C625D',
            link: '#9EB9FF',
            destructive: '#EE6E6C',
            placeholder: '#766C67',
            disabled: '#635955',
        },
        accent: {
            blue: '#9EB9FF',
            green: '#66DC7E',
            orange: '#E0B65A',
            yellow: '#F1C96A',
            red: '#EE6E6C',
            indigo: '#8EA3FF',
            purple: '#C0A7FF',
        },
        state: {
            success: {
                foreground: '#66DC7E',
                background: 'rgba(102, 220, 126, 0.15)',
                border: '#66DC7E',
            },
            warning: {
                foreground: '#E0B65A',
                background: 'rgba(224, 182, 90, 0.15)',
                border: '#E0B65A',
            },
            danger: {
                foreground: '#EE6E6C',
                background: 'rgba(238, 110, 108, 0.15)',
                border: '#EE6E6C',
            },
            info: {
                foreground: '#9EB9FF',
                background: 'rgba(158, 185, 255, 0.14)',
                border: '#9EB9FF',
            },
            neutral: {
                foreground: '#8A817C',
                background: '#2A2222',
                border: '#302727',
            },
            active: {
                foreground: '#9EB9FF',
                background: 'rgba(158, 185, 255, 0.12)',
                border: 'rgba(158, 185, 255, 0.50)',
            },
        },
        background: {
            canvas: '#131111',
        },
        surface: {
            base: '#191717',
            inset: '#171515',
            elevated: '#221C1C',
            ripple: 'rgba(255, 255, 255, 0.055)',
            pressed: '#302727',
            selected: '#292121',
            pressedOverlay: 'rgba(255,255,255,0.036)',
        },
        border: {
            default: 'rgba(255,255,255,0.050)',
            surface: 'rgba(255,255,255,0.056)',
            strong: 'rgba(255,255,255,0.090)',
            modal: 'rgba(255,255,255,0.064)',
        },
        effect: {
            surfaceHighlight: 'transparent',
        },
        chrome: {
            header: {
                background: '#131111',
                foreground: '#EFEFEF',
            },
        },
        overlay: {
            scrimSoft: 'rgba(19,17,17,0.54)',
            scrim: 'rgba(19,17,17,0.72)',
            scrimStrong: 'rgba(19,17,17,0.86)',
            scrimWizard: 'rgba(19,17,17,0.78)',
            foreground: '#EFEFEF',
            secondaryForeground: '#8A817C',
        },
        desktopPetOverlay: {
            bubble: {
                background: '#221C1C',
                backgroundPressed: '#302727',
                text: '#EFEFEF',
                textSecondary: '#8A817C',
                controlBackground: 'rgba(34, 28, 28, 0.96)',
                controlBackgroundPressed: '#2A2222',
            },
        },
        shadow: {
            color: '#000000',
            opacity: 0.1,
        },
        shadowLevels: buildDarkShadowLevels(),
        shadowPopoverArrowBoxShadow: buildShadowPopoverArrowBoxShadow(true),

        //
        // System components
        //

        switch: {
            track: {
                active: '#9EB9FF',
                inactive: '#252121',
            },
            thumb: {
                active: '#EFEFEF',
                inactive: '#766C67',
            },
        },
        fab: {
            background: '#221C1C',
            backgroundPressed: '#2A2323',
            gradient: createVerticalGradient(['#221C1C', '#251F1F']),
            icon: '#EFEFEF',
        },
        segmentedControl: {
            trackBackground: '#201A1A',
            trackGradient: undefined,
            activeBackground: '#2A2222',
            activeGradient: createVerticalGradient(['#2A2222', '#242020']),
        },
        radio: {
            active: '#9EB9FF',
            inactive: '#766C67',
            dot: '#131111',
        },
        button: {
            primary: {
                background: '#221C1C',
                gradient: createVerticalGradient(['#221C1C', '#251F1F']),
                tint: '#EFEFEF',
                disabled: '#2A2323',
            },
            secondary: {
                background: 'transparent',
                tint: '#EFEFEF',
            }
        },
        input: {
            background: '#171515',
            text: '#EFEFEF',
            placeholder: '#766C67',
        },
        composer: {
            chipTint: '#A79D97',
        },
        feed: {
            card: {
                background: '#221C1C',
            }
        },
        //
        // App components
        //

        status: { // App Connection Status
            connected: '#66DC7E',
            connecting: '#9EB9FF',
            actionRequired: '#E0B65A',
            disconnected: '#8A817C',
            error: '#EE6E6C',
            default: '#8A817C',
        },

        // Permission mode colors
        permission: {
            default: '#8A817C',
            acceptEdits: '#66DC7E',
            bypass: '#E0B65A',
            plan: '#C0A7FF',
            readOnly: '#9EB9FF',
            safeYolo: '#F1C96A',
            yolo: '#EE6E6C',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#66DC7E',
                text: '#EFEFEF',
            },
            deny: {
                background: '#EE6E6C',
                text: '#EFEFEF',
            },
            allowAll: {
                background: '#9EB9FF',
                text: '#EFEFEF',
            },
            inactive: {
                background: '#131111',
                border: 'rgba(255,255,255,0.050)',
                text: '#8A817C',
            },
            selected: {
                background: '#2A2222',
                border: 'rgba(255,255,255,0.090)',
                text: '#EFEFEF',
            },
        },


        // Diff view
        diff: {
            outline: '#302727',
            success: '#66DC7E',
            error: '#EE6E6C',
            added: {
                background: 'rgba(102, 220, 126, 0.12)',
                border: '#66DC7E',
                foreground: '#E7F4EA',
            },
            removed: {
                background: 'rgba(238, 110, 108, 0.12)',
                border: '#EE6E6C',
                foreground: '#F4DEDE',
            },
            context: {
                background: '#171515',
                foreground: '#8A817C',
            },
            lineNumber: {
                background: '#171515',
                foreground: '#766C67',
            },
            hunk: {
                background: 'rgba(158, 185, 255, 0.10)',
                foreground: '#9EB9FF',
            },
            leadingSpaceDot: '#302727',
            inlineAdded: {
                background: 'rgba(102, 220, 126, 0.16)',
                foreground: '#E7F4EA',
            },
            inlineRemoved: {
                background: 'rgba(238, 110, 108, 0.16)',
                foreground: '#F4DEDE',
            },
        },

        // Message View colors
        message: {
            user: {
                background: '#221C1C',
                foreground: '#EFEFEF',
            },
            agent: {
                foreground: '#EFEFEF',
            },
            event: {
                foreground: '#8A817C',
            },
        },

        // Code/Syntax colors (brighter for dark mode)
        syntax: {
            keyword: '#9EB9FF',
            string: '#66DC7E',
            comment: '#6C625D',
            number: '#E0B65A',
            function: '#C0A7FF',
            bracket1: '#FFD700',
            bracket2: '#C0A7FF',
            bracket3: '#9EB9FF',
            bracket4: '#FF8C00',
            bracket5: '#66DC7E',
            default: '#EFEFEF',
        },

        // Git status colors
        versionControl: {
            added: {
                foreground: '#66DC7E',
                background: 'rgba(102, 220, 126, 0.15)',
            },
            removed: {
                foreground: '#EE6E6C',
                background: 'rgba(238, 110, 108, 0.15)',
            },
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

export type Theme = typeof lightTheme;
