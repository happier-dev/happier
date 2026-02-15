import { describe, expect, it, vi } from 'vitest';

import type { BugReportsFeature } from './bugReportFeatureDefaults';
import { getBugReportDraftFieldErrors, submitBugReportFromDraft, validateBugReportDraft } from './bugReportSubmissionFlow';

const baseFeature: BugReportsFeature = {
  enabled: true,
  providerUrl: 'https://reports.happier.dev',
  defaultIncludeDiagnostics: true,
  maxArtifactBytes: 10 * 1024 * 1024,
  acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server'],
  uploadTimeoutMs: 20_000,
  contextWindowMs: 30 * 60 * 1_000,
};

const baseInput = {
  title: 'Crash on launch',
  summary: 'App freezes on startup after update',
  currentBehavior: 'The app stalls after splash screen.',
  expectedBehavior: 'The app should open the home screen.',
  reproductionStepsText: '1. Open app\n2. Wait 3 seconds',
  whatChangedRecently: '',
  frequency: 'often' as const,
  severity: 'high' as const,
  environment: {
    appVersion: '1.2.3',
    platform: 'ios',
    deploymentType: 'cloud' as const,
    serverUrl: 'https://api.happier.dev',
  },
  includeDiagnostics: true,
  acceptedPrivacyNotice: true,
};

describe('validateBugReportDraft', () => {
  it('returns structured validation errors for required fields and privacy consent', () => {
    expect(validateBugReportDraft({ ...baseInput, title: 'x' }).code).toBe('title');
    expect(validateBugReportDraft({ ...baseInput, summary: 'x' }).code).toBe('details');
    expect(validateBugReportDraft({ ...baseInput, acceptedPrivacyNotice: false, includeDiagnostics: true }).code).toBe('privacy');
    expect(validateBugReportDraft({ ...baseInput, acceptedPrivacyNotice: false, includeDiagnostics: false }).code).toBe('ok');
  });
});

describe('getBugReportDraftFieldErrors', () => {
  it('returns per-field min-length errors and privacy requirement', () => {
    expect(getBugReportDraftFieldErrors(baseInput)).toEqual({});

    expect(getBugReportDraftFieldErrors({ ...baseInput, title: 'x' }).title).toMatch(/at least 3/i);
    expect(getBugReportDraftFieldErrors({ ...baseInput, summary: 'x' }).summary).toMatch(/at least 3/i);
    expect(getBugReportDraftFieldErrors({ ...baseInput, includeDiagnostics: true, acceptedPrivacyNotice: false }).privacy).toBeTruthy();
  });
});

describe('submitBugReportFromDraft', () => {
  it('uses fallback flow when provider is disabled', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const submitBugReport = vi.fn(async () => ({
      reportId: 'report-1',
      issueNumber: 1,
      issueUrl: 'https://github.com/happier-dev/happier/issues/1',
    }));

	    const result = await submitBugReportFromDraft({
	      feature: { ...baseFeature, enabled: false },
	      machines: [],
	      input: baseInput,
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    });

    expect(result).toEqual({ mode: 'fallback' });
    expect(openFallbackIssue).toHaveBeenCalledTimes(1);
    expect(collectDiagnosticsArtifacts).not.toHaveBeenCalled();
    expect(submitBugReport).not.toHaveBeenCalled();
  });

  it('submits service report with normalized reproduction steps and diagnostics artifacts', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({
      artifacts: [
        {
          filename: 'app-console.log',
          sourceKind: 'ui-mobile',
          contentType: 'text/plain',
          content: 'tail',
        },
      ],
    }));
    const submitBugReport = vi.fn(async () => ({
      reportId: 'report-77',
      issueNumber: 77,
      issueUrl: 'https://github.com/happier-dev/happier/issues/77',
    }));

	    const result = await submitBugReportFromDraft({
	      feature: baseFeature,
	      machines: [],
	      input: baseInput,
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    });

    expect(result).toEqual({
      mode: 'submitted',
      reportId: 'report-77',
      issueNumber: 77,
      issueUrl: 'https://github.com/happier-dev/happier/issues/77',
      artifactCount: 1,
    });
    expect(submitBugReport).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        reproductionSteps: ['Open app', 'Wait 3 seconds'],
      }),
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          filename: 'app-console.log',
        }),
      ]),
    }));
    expect(openFallbackIssue).not.toHaveBeenCalled();
  });

  it('forces acceptedPrivacyNotice=true when diagnostics are not included', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const submitBugReport = vi.fn(async () => ({
      reportId: 'report-privacy-1',
      issueNumber: 2,
      issueUrl: 'https://github.com/happier-dev/happier/issues/2',
    }));

	    await submitBugReportFromDraft({
	      feature: baseFeature,
	      machines: [],
	      input: { ...baseInput, includeDiagnostics: false, acceptedPrivacyNotice: false },
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    });

    expect(submitBugReport).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        consent: expect.objectContaining({
          includeDiagnostics: false,
          acceptedPrivacyNotice: true,
        }),
      }),
    }));
  });

  it('does not include allowMaintainerFollowUp in the submitted form', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const submitBugReport = vi.fn(async (_input: unknown) => ({
      reportId: 'report-99',
      issueNumber: 99,
      issueUrl: 'https://github.com/happier-dev/happier/issues/99',
    }));

	    await submitBugReportFromDraft({
	      feature: baseFeature,
	      machines: [],
	      input: baseInput,
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    });

	    const call = submitBugReport.mock.calls[0]?.[0];
	    expect(call).toBeTruthy();
	    const consent = (call as any)?.form?.consent ?? {};
	    expect('allowMaintainerFollowUp' in consent).toBe(false);
	    expect('labels' in (call as any)).toBe(false);
	  });

  it('forwards selected existingIssueNumber to the submission client', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const submitBugReport = vi.fn(async () => ({
      reportId: 'report-existing',
      issueNumber: 42,
      issueUrl: 'https://github.com/happier-dev/happier/issues/42',
    }));

	    await submitBugReportFromDraft({
	      feature: baseFeature,
	      machines: [],
	      input: baseInput,
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      existingIssueNumber: 42,
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    } as any); // test-only: optional field is introduced as part of duplicate-issue flow

    expect(submitBugReport).toHaveBeenCalledWith(expect.objectContaining({
      existingIssueNumber: 42,
    }));
  });

  it('includes the reporter GitHub username in the submitted summary when provided', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const submitBugReport = vi.fn(async () => ({
      reportId: 'report-100',
      issueNumber: 100,
      issueUrl: 'https://github.com/happier-dev/happier/issues/100',
    }));

	    await submitBugReportFromDraft({
	      feature: baseFeature,
	      machines: [],
	      input: {
	        ...baseInput,
	        reporterGithubUsername: '@Foo-Bar',
	      },
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    });

    expect(submitBugReport).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        summary: `${baseInput.summary}\n\nReporter GitHub: \`Foo-Bar\``,
      }),
    }));
  });

  it('uses diagnostics kind overrides (intersected with server-accepted kinds) when collecting diagnostics', async () => {
    const openFallbackIssue = vi.fn(async () => {});
    const collectDiagnosticsArtifacts = vi.fn(async () => ({ artifacts: [] }));
    const submitBugReport = vi.fn(async () => ({
      reportId: 'report-77',
      issueNumber: 77,
      issueUrl: 'https://github.com/happier-dev/happier/issues/77',
    }));

	    await submitBugReportFromDraft({
	      feature: baseFeature,
	      machines: [],
	      input: {
	        ...baseInput,
	        diagnosticsKinds: ['daemon', 'not-a-real-kind'],
	      } as any,
	      issueOwner: 'happier-dev',
	      issueRepo: 'happier',
	      openFallbackIssue,
	      collectDiagnosticsArtifacts,
	      submitBugReport,
	    });

    expect(collectDiagnosticsArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      acceptedKinds: ['daemon'],
    }));
  });
});
