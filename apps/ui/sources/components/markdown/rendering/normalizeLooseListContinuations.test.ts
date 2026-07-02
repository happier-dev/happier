import { describe, expect, it } from 'vitest';

import { normalizeLooseListContinuations } from './normalizeLooseListContinuations';

describe('normalizeLooseListContinuations', () => {
    it('keeps prose after a complete sentence-style ordered list outside the list', () => {
        const markdown = [
            'There are only two valid choices:',
            '',
            '1. Queue it for the next fresh turn.',
            '2. Stop/interrupt the current turn, then send it as a fresh turn now.',
            '',
            'So the UX should expose that distinction.',
        ].join('\n');

        expect(normalizeLooseListContinuations(markdown)).toBe(markdown);
    });

    it('keeps prose after a complete sentence-style preset list outside the list', () => {
        const markdown = [
            'So my recommendation is:',
            '',
            '1. Keep `Night Dark` as the cooler, blue-gray theme.',
            '2. Add `Pitch Dark` as the darker, more neutral one.',
            '3. Make `Pitch Dark` slightly warmer and flatter than `Night Dark`, but not as bright as `Crisp Dark`.',
            '',
            'That gives you a clean separation:',
        ].join('\n');

        expect(normalizeLooseListContinuations(markdown)).toBe(markdown);
    });

    it('keeps prose after a final heading-style ordered list item outside the list', () => {
        const markdown = [
            "Done. I've created a 5-item internal to-do list scoped to the current branch's changes:",
            '',
            '1. **Review monorepo structure and package layout** — pending',
            '2. **Audit CLI backend and RPC handler changes** — pending',
            '3. **Review UI screen and component modifications** — pending',
            '4. **Check stack scripts and Tauri dev runtime updates** — pending',
            '5. **Summarize findings and open questions** — pending',
            '',
            'The list is live in the session.',
        ].join('\n');

        expect(normalizeLooseListContinuations(markdown)).toBe(markdown);
    });

    it('keeps prose after a restarted final ordered list item outside the list', () => {
        const markdown = [
            '1. **First group item**',
            '',
            'Details for the first group item.',
            '',
            '1. **Second group item**',
            '',
            'Details for the second group item.',
            '',
            'The restarted list is complete.',
        ].join('\n');

        expect(normalizeLooseListContinuations(markdown)).toBe([
            '1. **First group item**',
            '',
            '   Details for the first group item.',
            '',
            '1. **Second group item**',
            '',
            'Details for the second group item.',
            '',
            'The restarted list is complete.',
        ].join('\n'));
    });

    it('normalizes heading-style list item continuation paragraphs', () => {
        expect(normalizeLooseListContinuations([
            '1. **Folder as user-owned organization state**',
            '',
            'Open WebUI gets this right.',
            '',
            '2. **Flat storage, tree derived in UI/domain code**',
            '',
            'They store folders flat with `parent_id`.',
        ].join('\n'))).toBe([
            '1. **Folder as user-owned organization state**',
            '',
            '   Open WebUI gets this right.',
            '',
            '2. **Flat storage, tree derived in UI/domain code**',
            '',
            'They store folders flat with `parent_id`.',
        ].join('\n'));
    });

    it('normalizes period-ending title continuations only up to the next list boundary', () => {
        expect(normalizeLooseListContinuations([
            '1. Provider cards as operational dashboards.',
            '',
            'Cards combine provider identity, health, route status, and actions.',
            '',
            '2. Explicit switch mode vs additive mode.',
            '',
            'The model is simple and user-aligned.',
            '',
            '**Next Section**',
            '',
            'This paragraph must stay outside the list.',
        ].join('\n'))).toBe([
            '1. Provider cards as operational dashboards.',
            '',
            '   Cards combine provider identity, health, route status, and actions.',
            '',
            '2. Explicit switch mode vs additive mode.',
            '',
            '   The model is simple and user-aligned.',
            '',
            '**Next Section**',
            '',
            'This paragraph must stay outside the list.',
        ].join('\n'));
    });

    it('normalizes multi-block continuations before the next ordered marker', () => {
        expect(normalizeLooseListContinuations([
            '1. Add a “Provider Accounts” quick-switch screen.',
            '',
            'Build on existing connected services and account groups. Show:',
            '',
            '- Provider/agent.',
            '- Current connected profile.',
            '',
            'Use existing architecture:',
            '',
            '- `packages/agents/src/manifest.ts`',
            '- `apps/cli/src/backends/catalog.ts`',
            '',
            '2. Add compact provider/account cards.',
            '',
            'Each card should show:',
            '',
            '- Agent icon/name.',
            '- CLI install/resolution status.',
            '',
            '3. Add a read-only terminal status command.',
        ].join('\n'))).toBe([
            '1. Add a “Provider Accounts” quick-switch screen.',
            '',
            '   Build on existing connected services and account groups. Show:',
            '',
            '   - Provider/agent.',
            '   - Current connected profile.',
            '',
            '   Use existing architecture:',
            '',
            '   - `packages/agents/src/manifest.ts`',
            '   - `apps/cli/src/backends/catalog.ts`',
            '',
            '2. Add compact provider/account cards.',
            '',
            '   Each card should show:',
            '',
            '   - Agent icon/name.',
            '   - CLI install/resolution status.',
            '',
            '3. Add a read-only terminal status command.',
        ].join('\n'));
    });

    it('normalizes heading-style ordered lists that use one-dot markers for every item', () => {
        expect(normalizeLooseListContinuations([
            '1. **First idea**',
            '',
            'Description for the first idea.',
            '',
            '1. **Second idea**',
            '',
            'Description for the second idea.',
        ].join('\n'))).toBe([
            '1. **First idea**',
            '',
            '   Description for the first idea.',
            '',
            '1. **Second idea**',
            '',
            'Description for the second idea.',
        ].join('\n'));
    });
});
