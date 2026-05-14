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
            primary: '#ffffff',
            secondary: '#99999d',
            tertiary: '#747478',
            link: '#2BACCC',
            destructive: '#FF453A',
            placeholder: '#8E8E93',
            disabled: '#48484A',
        },
        accent: {
            blue: '#0A84FF',
            green: '#32D74B',
            orange: '#FF9F0A',
            yellow: '#FFD60A',
            red: '#FF453A',
            indigo: '#9FA8DA',
            purple: '#CE93D8',
        },
        state: {
            success: {
                foreground: '#32D74B',
                background: 'rgba(50, 215, 75, 0.15)',
                border: '#32D74B',
            },
            warning: {
                foreground: '#FF9F0A',
                background: 'rgba(255, 159, 10, 0.15)',
                border: '#FF9F0A',
            },
            danger: {
                foreground: '#FF453A',
                background: 'rgba(255, 69, 58, 0.15)',
                border: '#FF453A',
            },
            info: {
                foreground: '#9FA8DA',
                background: 'rgba(10, 132, 255, 0.14)',
                border: '#0A84FF',
            },
            neutral: {
                foreground: '#8E8E93',
                background: '#2C2C2E',
                border: '#38383A',
            },
            active: {
                foreground: '#0A84FF',
                background: 'rgba(10, 132, 255, 0.12)',
                border: 'rgba(10, 132, 255, 0.55)',
            },
        },
        background: {
            canvas: '#181818',
        },
        surface: {
            base: '#202020',
            inset: '#171717',
            elevated: '#292929',
            ripple: 'rgba(255, 255, 255, 0.08)',
            pressed: '#2C2C2C',
            selected: '#2C2C2C',
            pressedOverlay: Platform.select({ ios: '#2C2C2C', default: 'transparent' }),
        },
        border: {
            default: '#292929',
            surface: 'transparent',
            strong: '#3a3a3a',
            modal: 'rgba(255, 255, 255, 0.1)',
        },
        effect: {
            surfaceHighlight: 'transparent',
        },
        chrome: {
            header: {
                background: '#202020',
                foreground: '#ffffff',
            },
        },
        overlay: {
            scrimSoft: 'rgba(0, 0, 0, 0.45)',
            scrim: 'rgba(0, 0, 0, 0.45)',
            scrimStrong: 'rgba(0, 0, 0, 0.58)',
            scrimWizard: 'rgba(0, 0, 0, 0.42)',
            foreground: '#FFFFFF',
            secondaryForeground: 'rgba(255, 255, 255, 0.9)',
        },
        desktopPetOverlay: {
            bubble: {
                background: '#2C2C2C',
                backgroundPressed: '#343434',
                text: '#FFFFFF',
                textSecondary: '#B4B4B8',
                controlBackground: 'rgba(44, 44, 44, 0.96)',
                controlBackgroundPressed: '#3A3A3A',
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
                active: '#1976D2',
                inactive: '#3a393f',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        fab: {
            background: '#303030',
            backgroundPressed: '#1b1b1b',
            gradient: createVerticalGradient(['#303030', '#323232']),
            icon: '#ffffff',
        },
        segmentedControl: {
            trackBackground: '#292929',
            trackGradient: undefined,
            activeBackground: '#202020',
            activeGradient: createVerticalGradient(['#202020', '#212121']),
        },
        radio: {
            active: '#0A84FF',
            inactive: '#48484A',
            dot: '#0A84FF',
        },
        button: {
            primary: {
                background: '#1b1b1b',
                gradient: createVerticalGradient(['#1b1b1b', '#1c1c1c']),
                tint: '#FFFFFF',
                disabled: '#C0C0C0',
            },
            secondary: {
                background: 'transparent',
                tint: '#8E8E93',
            }
        },
        input: {
            background: '#303030',
            text: '#FFFFFF',
            placeholder: '#8E8E93',
        },
        feed: {
            card: {
                background: '#242424',
            }
        },
        //
        // App components
        //

        status: { // App Connection Status
            connected: '#34C759',
            connecting: '#FFFFFF',
            actionRequired: '#FF9F0A',
            disconnected: '#8E8E93',
            error: '#FF453A',
            default: '#8E8E93',
        },

        // Permission mode colors
        permission: {
            default: '#8E8E93',
            acceptEdits: '#0A84FF',
            bypass: '#FF9F0A',
            plan: '#32D74B',
            readOnly: '#98989D',
            safeYolo: '#FF7A4C',
            yolo: '#FF453A',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#32D74B',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF453A',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#0A84FF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#2C2C2E',
                border: '#38383A',
                text: '#8E8E93',
            },
            selected: {
                background: '#1C1C1E',
                border: '#38383A',
                text: '#FFFFFF',
            },
        },


        // Diff view
        diff: {
            outline: '#30363D',
            success: '#3FB950',
            error: '#F85149',
            added: {
                background: '#0D2E1F',
                border: '#3FB950',
                foreground: '#C9D1D9',
            },
            removed: {
                background: '#3F1B23',
                border: '#F85149',
                foreground: '#C9D1D9',
            },
            context: {
                background: '#161B22',
                foreground: '#8B949E',
            },
            lineNumber: {
                background: '#161B22',
                foreground: '#6E7681',
            },
            hunk: {
                background: '#161B22',
                foreground: '#58A6FF',
            },
            leadingSpaceDot: '#2A2A2A',
            inlineAdded: {
                background: '#2A5A2A',
                foreground: '#7AFF7A',
            },
            inlineRemoved: {
                background: '#5A2A2A',
                foreground: '#FF7A7A',
            },
        },

        // Message View colors
        message: {
            user: {
                background: '#2C2C2C',
                foreground: '#FFFFFF',
            },
            agent: {
                foreground: '#FFFFFF',
            },
            event: {
                foreground: '#8E8E93',
            },
        },

        // Code/Syntax colors (brighter for dark mode)
        syntax: {
            keyword: '#569CD6',
            string: '#CE9178',
            comment: '#6A9955',
            number: '#B5CEA8',
            function: '#DCDCAA',
            bracket1: '#FFD700',
            bracket2: '#DA70D6',
            bracket3: '#179FFF',
            bracket4: '#FF8C00',
            bracket5: '#00FF00',
            default: '#D4D4D4',
        },

        // Git status colors
        versionControl: {
            added: {
                foreground: '#34C759',
                background: 'rgba(52, 199, 89, 0.15)',
            },
            removed: {
                foreground: '#FF453A',
                background: 'rgba(255, 69, 58, 0.15)',
            },
        },

    },

    ...sharedSpacing,
} satisfies typeof lightTheme;

export type Theme = typeof lightTheme;
