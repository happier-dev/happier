import { describe, expect, it } from 'vitest';
import { getHasAnyAgentInputActions, resolveAgentInputActionBarLayout, shouldShowSecondaryControlRow } from './actionBarLogic';

describe('agentInput/actionBarLogic', () => {
    it('reads auto as 0.2 did: one scrolling rail per row on the web and phones, wrapping on wide native', () => {
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'auto', platform: 'web', isMobileLayout: false })).toBe('scroll');
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'auto', platform: 'web', isMobileLayout: true })).toBe('scroll');
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'auto', platform: 'ios', isMobileLayout: true })).toBe('scroll');
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'auto', platform: 'ios', isMobileLayout: false })).toBe('wrap');
        // An explicit choice wins everywhere.
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'wrap', platform: 'web', isMobileLayout: false })).toBe('wrap');
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'scroll', platform: 'ios', isMobileLayout: false })).toBe('scroll');
    });

    it('lets a narrow host card ask for wrap while an explicit choice still wins (FIN M5)', () => {
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'auto', hostLayout: 'wrap', platform: 'web', isMobileLayout: false })).toBe('wrap');
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'scroll', hostLayout: 'wrap', platform: 'web', isMobileLayout: false })).toBe('scroll');
        expect(resolveAgentInputActionBarLayout({ configuredLayout: 'auto', platform: 'web', isMobileLayout: false })).toBe('scroll');
    });

    it('shows the secondary controls row in wrap and scroll modes when controls exist', () => {
        expect(shouldShowSecondaryControlRow('wrap', true)).toBe(true);
        expect(shouldShowSecondaryControlRow('wrap', false)).toBe(false);
        expect(shouldShowSecondaryControlRow('scroll', true)).toBe(true);
        expect(shouldShowSecondaryControlRow('scroll', false)).toBe(false);
        expect(shouldShowSecondaryControlRow('collapsed', true)).toBe(false);
    });

    it('treats resume as an action (prevents collapsed menu from being empty)', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: false,
            hasExtraActionChips: false,
            hasMachine: false,
            hasPath: false,
            hasResume: true,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });

    it('returns false when there are no actions', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: false,
            hasExtraActionChips: false,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(false);
    });

    it('treats delivery as an action so collapsed controls stay reachable', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: true,
            hasExtraActionChips: false,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });

    it('treats canonical extra action chips as actions so collapsed controls stay reachable', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: false,
            hasExtraActionChips: true,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });
});
