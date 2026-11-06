import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollView } from 'react-native';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import type { AgentInputPlacementDescriptor } from '../controls/agentInputControlTypes';
import { ComposerPlacementPreview } from './ComposerPlacementPreview';

const windowSize = vi.hoisted(() => ({ width: 390, height: 844 }));
// The window is the platform boundary; the preview's own viewport decision stays real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'ios' }, { Dimensions: { get: () => windowSize, addEventListener: () => ({ remove: () => {} }) },
        useWindowDimensions: () => windowSize }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const chip = (id: string, title: string): AgentInputPlacementDescriptor => ({
    id, controlId: id as AgentInputPlacementDescriptor['controlId'], title, icon: 'gear', line: 'primary', slot: 'chip',
    defaultPlacement: 'pinned', pending: false,
});
const descriptors = [chip('model', 'Model'), chip('permissions', 'Permissions'), chip('mode', 'Mode'),
    chip('machine', 'Machine'), chip('folder', 'Folder')];

afterEach(async () => {
    await standardCleanup();
    windowSize.width = 390;
});

describe('composer placement preview', () => {
    it('draws the real composer row on a phone: one line that scrolls sideways, never wrapped (ACCEPT-OPUS)', async () => {
        const screen = await renderScreen(<ComposerPlacementPreview descriptors={descriptors} preferences={{ orderedIds: [], placements: {} }} />);
        const rows = screen.findAllByType(ScrollView).filter((node) => node.props.horizontal === true);
        expect(rows).toHaveLength(1);
        for (const descriptor of descriptors) {
            expect(rows[0]!.findAll((node) => node.props?.testID === `composer-placement-preview.chip:${descriptor.id}`).length).toBeGreaterThan(0);
        }
    });

    it('shows each chip as the real composer does: its value and mark, the shield alone, accessories in the field', async () => {
        windowSize.width = 1440;
        const permission = { ...chip('permissions', 'Permissions'), controlId: 'permission' } as AgentInputPlacementDescriptor;
        const engine = { ...chip('model', 'Model'), controlId: 'engine' } as AgentInputPlacementDescriptor;
        const accessory: AgentInputPlacementDescriptor = { ...chip('voice', 'Dictate'), slot: 'fieldAccessory' };
        const screen = await renderScreen(<ComposerPlacementPreview descriptors={[engine, permission, accessory]}
            preferences={{ orderedIds: [], placements: {} }}
            values={{ engine: { label: 'Opus 5.5' } }} placeholder="What would you like to work on?" />);
        const texts = (id: string) => screen.findByTestId(id)!.findAll((node) => typeof node.children?.[0] === 'string').map((node) => node.children[0]);
        expect(texts('composer-placement-preview.chip:model')).toContain('Opus 5.5');
        expect(texts('composer-placement-preview.chip:model')).not.toContain('Model');
        expect(texts('composer-placement-preview.chip:permissions')).toEqual([]);
        // The field line holds the prompt and its accessories, above the rail, as the live composer draws them.
        const field = screen.findByTestId('composer-placement-preview.field')!;
        expect(field.findAll((node) => node.props?.testID === 'composer-placement-preview.accessory:voice').length).toBeGreaterThan(0);
        expect(texts('composer-placement-preview.field')).toContain('What would you like to work on?');
    });

    it('lays the chips on the same lines as the live composer: location controls on their own line, or one rail in a session', async () => {
        windowSize.width = 1440;
        const line = (id: string, value: 'primary' | 'secondary') => ({ ...chip(id, id), line: value });
        const controls = [line('model', 'primary'), line('machine', 'secondary')];
        const lineOf = (screen: Awaited<ReturnType<typeof renderScreen>>, name: string) => screen.findByTestId(`composer-placement-preview.line:${name}`);
        const twoLines = await renderScreen(<ComposerPlacementPreview descriptors={controls} preferences={{ orderedIds: [], placements: {} }} />);
        expect(lineOf(twoLines, 'primary')!.findAll((node) => node.props?.testID === 'composer-placement-preview.chip:model').length).toBeGreaterThan(0);
        expect(lineOf(twoLines, 'secondary')!.findAll((node) => node.props?.testID === 'composer-placement-preview.chip:machine').length).toBeGreaterThan(0);
        const oneRail = await renderScreen(<ComposerPlacementPreview descriptors={controls} preferences={{ orderedIds: [], placements: {} }} singleRow />);
        expect(lineOf(oneRail, 'secondary')).toBeFalsy();
        expect(lineOf(oneRail, 'primary')!.findAll((node) => node.props?.testID === 'composer-placement-preview.chip:machine').length).toBeGreaterThan(0);
    });

    it('leaves out a chip its composer does not draw now, however it is placed', async () => {
        windowSize.width = 1280;
        const screen = await renderScreen(<ComposerPlacementPreview descriptors={descriptors} preferences={{ orderedIds: [], placements: {} }}
            values={{ mode: { absent: true } }} />);
        expect(screen.findByTestId('composer-placement-preview.chip:mode')).toBeNull();
        expect(screen.findByTestId('composer-placement-preview.chip:model')).not.toBeNull();
    });

    it('says a chip\'s value keyed by its own placement, for controls that share a control id', async () => {
        windowSize.width = 1440;
        const space = { ...chip('space', 'Space'), controlId: 'organization' } as AgentInputPlacementDescriptor;
        const screen = await renderScreen(<ComposerPlacementPreview descriptors={[space]} preferences={{ orderedIds: [], placements: {} }}
            values={{ space: { label: 'My work' } }} />);
        expect(screen.findByTestId('composer-placement-preview.chip:space')!.findAll((node) => node.children?.[0] === 'My work').length).toBeGreaterThan(0);
    });

    it('keeps the wrapping row on a wide window, where every Shown chip fits', async () => {
        windowSize.width = 1200;
        const screen = await renderScreen(<ComposerPlacementPreview descriptors={descriptors} preferences={{ orderedIds: [], placements: {} }} />);
        expect(screen.findAllByType(ScrollView).filter((node) => node.props.horizontal === true)).toHaveLength(0);
        expect(screen.findAllByTestId('composer-placement-preview.chip:folder').length).toBeGreaterThan(0);
    });
});
