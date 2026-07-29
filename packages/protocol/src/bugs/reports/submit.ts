import type { BugReportFormPayload, BugReportServiceSubmitInput } from './types.js';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from './redaction.js';
import { normalizeBugReportProviderUrl, sanitizeBugReportUrl } from './sanitize.js';
import { normalizeBugReportIssueTarget } from './issueTarget.js';
import { utf8ByteLength } from './utf8.js';
import { postJson, readSafeBugReportErrorText, withAbortTimeout } from './http.js';

export async function submitBugReportToService(input: BugReportServiceSubmitInput): Promise<{
  reportId: string;
  issueNumber: number;
  issueUrl: string;
}> {
  const baseUrl = normalizeBugReportProviderUrl(input.providerUrl);
  if (!baseUrl) {
    throw new Error('Invalid bug report provider URL');
  }
  const issueTarget = normalizeBugReportIssueTarget({
    owner: input.issueOwner,
    repo: input.issueRepo,
  });
  if (!issueTarget) {
    throw new Error('Invalid bug report issue target');
  }
  const clientPrefix = (input.clientPrefix ?? 'client').trim() || 'client';
  const clientReportId = `${clientPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const sanitizedForm: BugReportFormPayload = {
    ...input.form,
    environment: {
      ...input.form.environment,
      serverUrl: sanitizeBugReportUrl(input.form.environment.serverUrl),
    },
  };

  const maxArtifactBytes = Number.isFinite(input.maxArtifactBytes)
    ? Math.max(1024, Math.floor(input.maxArtifactBytes!))
    : 10 * 1024 * 1024;
  const sanitizedArtifacts = input.artifacts.map((artifact) => ({
    ...artifact,
    content: trimBugReportTextToMaxBytes(redactBugReportSensitiveText(artifact.content), maxArtifactBytes),
  }));

  const session = await postJson<{
    reportId: string;
    uploadTargets: Array<{
      artifactId: string;
      objectKey: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    }>;
  }>({
    url: `${baseUrl}/v1/reports/session`,
    timeoutMs: input.timeoutMs,
    body: {
      clientReportId,
      form: sanitizedForm,
      artifacts: sanitizedArtifacts.map((artifact) => ({
        filename: artifact.filename,
        contentType: artifact.contentType,
        sizeBytes: utf8ByteLength(artifact.content),
        sourceKind: artifact.sourceKind,
      })),
    },
  });

  if (session.uploadTargets.length !== sanitizedArtifacts.length) {
    throw new Error(
      `Upload target count mismatch: expected ${sanitizedArtifacts.length}, got ${session.uploadTargets.length}`,
    );
  }

  const uploadedArtifacts: Array<{ artifactId: string; objectKey: string; sizeBytes: number }> = [];
  for (let index = 0; index < session.uploadTargets.length; index += 1) {
    const target = session.uploadTargets[index];
    const artifact = sanitizedArtifacts[index];
    if (!target || !artifact) {
      throw new Error(`Missing upload target mapping for artifact index ${index}`);
    }

    const headers = new Headers(target.requiredHeaders ?? {});
    if (!headers.has('content-type')) {
      headers.set('content-type', artifact.contentType);
    }

    const uploadResponse = await withAbortTimeout(input.timeoutMs, async (signal) =>
      await fetch(target.uploadUrl, {
        method: 'PUT',
        headers,
        body: artifact.content,
        signal,
      }),
    );

    if (!uploadResponse.ok) {
      const uploadError = await readSafeBugReportErrorText(uploadResponse);
      throw new Error(`Artifact upload failed (${uploadResponse.status}): ${uploadError || artifact.filename}`);
    }

    uploadedArtifacts.push({
      artifactId: target.artifactId,
      objectKey: target.objectKey,
      sizeBytes: utf8ByteLength(artifact.content),
    });
  }

  const submit = await postJson<{
    reportId: string;
    issueNumber: number;
    issueUrl: string;
  }>({
    url: `${baseUrl}/v1/reports/submit`,
    timeoutMs: input.timeoutMs,
    body: {
      reportId: session.reportId,
      uploadedArtifacts,
      issue: {
        owner: issueTarget.owner,
        repo: issueTarget.repo,
        number: input.existingIssueNumber,
      },
    },
  });

  return submit;
}
