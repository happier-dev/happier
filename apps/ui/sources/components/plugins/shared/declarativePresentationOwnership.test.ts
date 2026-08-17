import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('declarative shared-presentation ownership', () => {
    it('keeps the presentation catalog on the mounted plugin-surface environment owner', () => {
        const source = readFileSync(
            new URL('../../../app/(app)/dev/plugin-ui.tsx', import.meta.url),
            'utf8',
        );

        expect(source).toContain("from '@/components/plugins/surfaces/pluginSurfaceContext'");
        expect(source).toContain('usePluginSurfaceEnvironment(');
        expect(source).toContain('createPluginSurfaceContext({');
        expect(source).not.toContain('reducedMotion: false');
        expect(source).not.toContain('screenReaderEnabled: false');
        expect(source).not.toContain('safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 }');
    });

    it('adapts structure and press lifecycle through plugin-ui presentation instead of local RN copies', () => {
        const source = readFileSync(new URL('./declarativeNodes.tsx', import.meta.url), 'utf8');

        expect(source).toContain("from '@happier-dev/plugin-ui/presentation'");
        expect(source).toContain('<HappierStack');
        expect(source).toContain('<HappierList');
        expect(source).toContain('<HappierPressable');
        expect(source).not.toMatch(/import \{[^}]*\bPressable\b[^}]*\} from 'react-native'/su);
    });

    it('routes mounted declarative field chrome through the shared form owner without taking settings authority', () => {
        const source = readFileSync(new URL('../surfaces/DeclarativePluginSurface.tsx', import.meta.url), 'utf8');

        expect(source).toContain("from '@happier-dev/plugin-ui/presentation'");
        expect(source).toContain('<HappierField');
        expect(source).toContain('<HappierTextField');
        expect(source).toContain('<HappierToggle');
        expect(source).toContain('<HappierSelect');
        // This renderer owns setting reads/writes and freshness fencing, not a
        // second set of native form-control semantics.
        expect(source).not.toMatch(/import \{[^}]*\bPressable\b[^}]*\} from 'react-native'/su);
        expect(source).not.toContain("from '@/components/ui/forms/Switch'");
        expect(source).not.toMatch(/import \{[^}]*\bTextInput\b[^}]*\} from '@\/components\/ui\/text\/Text'/su);
    });

    it('does not schedule a dead interaction-freshness state update during render', () => {
        const source = readFileSync(new URL('../surfaces/DeclarativePluginSurface.tsx', import.meta.url), 'utf8');

        // Interaction admission/currentness belongs to the mounted controller and
        // its projections. A renderer-local state update from `interactionEnabled`
        // only schedules a second render: this surface has no consumer for that
        // freshness tuple.
        expect(source).not.toMatch(
            /const\s*\[\s*interactionFreshness\s*,\s*setInteractionFreshness\s*\]\s*=\s*React\.useState\([\s\S]{0,600}setInteractionFreshness\s*\(/u,
        );
    });

    it('routes action-panel grouping through the shared semantic toolbar owner', () => {
        const source = readFileSync(new URL('./declarativeNodes.tsx', import.meta.url), 'utf8');

        expect(source).toContain('<HappierActionPanel');
        expect(source).not.toMatch(/<View[\s\S]{0,240}accessibilityRole="toolbar"/u);
    });

    it('routes declarative list rows through the shared semantic row owner', () => {
        const source = readFileSync(new URL('./declarativeNodes.tsx', import.meta.url), 'utf8');

        expect(source).toContain('<HappierListItem');
        expect(source).not.toContain("from '@/components/ui/lists/Item'");
    });

    it('routes declarative state containers through the shared info-state owner', () => {
        const source = readFileSync(new URL('./declarativeNodes.tsx', import.meta.url), 'utf8');

        expect(source).toContain('<HappierInfoState');
        expect(source).toContain('<HappierInfoTile');
        expect(source).not.toMatch(/<View[\s\S]{0,360}testID=\{`plugin-declarative-state:/u);
    });

    it('routes declarative status rows through the shared status owner', () => {
        const source = readFileSync(new URL('./declarativeNodes.tsx', import.meta.url), 'utf8');

        expect(source).toContain('<HappierStatus');
        expect(source).not.toContain('<HappierStatusDot');
        expect(source).not.toMatch(/status: \(node, context\) => \(\s*<View/su);
    });

    it('routes declarative Markdown through the shared semantic content owner', () => {
        const source = readFileSync(new URL('./declarativeNodes.tsx', import.meta.url), 'utf8');

        expect(source).toContain('<HappierMarkdown');
        expect(source).toContain('renderContent={(input) =>');
        expect(source).not.toMatch(/markdown: \(node, context\) => \(\s*<MarkdownView/su);
    });
});
