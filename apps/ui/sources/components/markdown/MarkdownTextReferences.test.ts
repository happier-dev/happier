import { describe, expect, it } from 'vitest';
import { linkifyMarkdownTextReferences } from './MarkdownTextReferences';

describe('display-time Markdown session references', () => {
    it('links prose and possessives without changing commands, existing links, or destinations', () => {
        const references = { 'happier-6e': { text: 'Release [prep]', url: '/session/actual' } };
        const prose = "Ask **happier-6e** about happier-6e's change; happier-eb stays unknown.";
        expect(linkifyMarkdownTextReferences(prose, references)).toBe("Ask **[Release \\[prep\\]](/session/actual)** about [Release \\[prep\\]](/session/actual)'s change; happier-eb stays unknown.");
        const protectedSource = ['`echo happier-6e`', '`src/happier-6e/file`', '`happier-eb`', '```txt\nhappier-6e\n```', '[happier-6e](/existing)', '[`happier-6e`](/existing)', '[label](/happier-6e)', 'src/happier-6e/file', 'happier-6e-extra'].join('\n\n');
        expect(linkifyMarkdownTextReferences(protectedSource, references)).toBe(protectedSource);
    });

    it('links a standalone inline-code reference while preserving surrounding authored Markdown', () => {
        const references = { 'happier-6e': { text: 'Release prep', url: '/session/actual' } };
        const source = "Ask `happier-6e` about `` happier-6e ``'s change, then happier-6e.";
        expect(linkifyMarkdownTextReferences(source, references)).toBe("Ask [Release prep](/session/actual) about [Release prep](/session/actual)'s change, then [Release prep](/session/actual).");
    });
});
