import { describe, expect, it } from 'vitest';

import { buildFallbackIssueUrl, formatFallbackIssueBody, normalizeReproductionSteps } from './bugReportFallback';

describe('normalizeReproductionSteps', () => {
    it('extracts ordered steps from free-form text', () => {
        const steps = normalizeReproductionSteps('1. Open app\n2) Click settings\n- Tap report issue\n\n   4. done');
        expect(steps).toEqual(['Open app', 'Click settings', 'Tap report issue', 'done']);
    });

    it('returns an empty list when input is empty', () => {
        const steps = normalizeReproductionSteps('   ');
        expect(steps).toEqual([]);
    });
});

describe('formatFallbackIssueBody', () => {
    it('renders the structured fields and diagnostics note', () => {
        const body = formatFallbackIssueBody({
            summary: 'The app disconnects from daemon',
            currentBehavior: 'Sessions drop after a minute.',
            expectedBehavior: 'Sessions should stay connected.',
            reproductionSteps: ['Open the app', 'Start a session'],
            frequency: 'often',
            severity: 'high',
            environment: {
                appVersion: '1.2.3',
                platform: 'ios',
                deploymentType: 'self-hosted',
                serverUrl: 'https://example.dev',
            },
            whatChangedRecently: 'Upgraded CLI yesterday',
            diagnosticsIncluded: false,
        });

        expect(body).toMatch(/(^|\n)#+\s+Summary\b/);
        expect(body).toMatch(/(^|\n)#+\s+Reproduction steps\b/i);
        expect(body).toContain('Sessions drop after a minute.');
        expect(body).toContain('Diagnostics: not included');
        expect(body).toContain('Upgraded CLI yesterday');
        // Privacy: never include server URLs in GitHub issues.
        expect(body).not.toContain('Server URL:');
        expect(body).not.toContain('https://example.dev');
    });

    it('does not include server URL even when provided', () => {
        const body = formatFallbackIssueBody({
            summary: 'summary',
            currentBehavior: 'current',
            expectedBehavior: 'expected',
            reproductionSteps: ['step'],
            frequency: 'often',
            severity: 'medium',
            environment: {
                appVersion: '1.2.3',
                platform: 'ios',
                deploymentType: 'self-hosted',
                serverUrl: 'https://admin:super-secret@example.dev:8443/api?token=abc123',
            },
            diagnosticsIncluded: true,
        });

        expect(body).not.toContain('Server URL:');
        expect(body).not.toContain('example.dev');
        expect(body).not.toContain('admin:super-secret');
        expect(body).not.toContain('?token=');
    });
});

describe('buildFallbackIssueUrl', () => {
    it('creates a prefilled issue URL', () => {
        const url = buildFallbackIssueUrl({
            title: 'Session disconnects',
            body: 'Body text',
            owner: 'happier-dev',
            repo: 'happier',
        });

	        expect(url).toContain('https://github.com/happier-dev/happier/issues/new?');
	        expect(url).toContain('title=Session%20disconnects');
	        expect(url).toContain('body=Body%20text');
	        expect(url).not.toContain('labels=');
	    });

    it('keeps generated issue URL under practical browser limits', () => {
        const veryLargeBody = `Summary\n${'x'.repeat(40_000)}`;
        const url = buildFallbackIssueUrl({
            title: 'Session disconnects',
            body: veryLargeBody,
            owner: 'happier-dev',
            repo: 'happier',
        });

        expect(url.length).toBeLessThanOrEqual(7600);
        expect(url).toContain('title=Session%20disconnects');
    });

	  it('falls back to default owner/repo when provided values are invalid', () => {
	    const url = buildFallbackIssueUrl({
	      title: 'Session disconnects',
      body: 'Body text',
      owner: 'foo?bar',
      repo: '../repo',
    });

    expect(url).toContain('https://github.com/happier-dev/happier/issues/new?');
    expect(url).not.toContain('foo?bar');
    expect(url).not.toContain('../repo');
  });
});
