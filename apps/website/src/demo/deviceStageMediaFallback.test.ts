import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeviceStage } from './DeviceStage';
import { directSessionsScenario } from './scenarios/directSessions';
import { remoteLaunchScenario } from './scenarios/remoteLaunch';

const DeviceStageComponent: ComponentType<NonNullable<Parameters<typeof DeviceStage>[0]>> =
    DeviceStage;

describe('DeviceStage media fallbacks', () => {
    it('renders real fallback media for remote-launch beats that do not declare media', () => {
        const markup = renderToStaticMarkup(
            createElement(DeviceStageComponent, {
                demoId: 'remote-launch-test',
                scenario: remoteLaunchScenario,
                phoneView: 'phone-new-session',
                desktopView: 'desktop-session',
            }),
        );

        expect(markup).toContain('/images/demo/sim/phone-new-session.png');
        expect(markup).toContain('/images/demo/sessions/desktop-session-list.png');
        expect(markup).not.toContain('>phone</span>');
        expect(markup).not.toContain('>desktop</span>');
    });

    it('renders desktop browse fallback media instead of a literal placeholder label', () => {
        const markup = renderToStaticMarkup(
            createElement(DeviceStageComponent, {
                demoId: 'direct-sessions-test',
                scenario: directSessionsScenario,
                phoneView: 'phone-session',
                desktopView: 'direct-browse',
            }),
        );

        expect(markup).toContain('/images/demo/sessions/phone-session-list.png');
        expect(markup).toContain('/images/demo/sessions/desktop-session-list.png');
        expect(markup).not.toContain('>phone</span>');
        expect(markup).not.toContain('>desktop</span>');
    });
});
