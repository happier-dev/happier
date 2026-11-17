import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 } from '../../runtime/input/composerAttachmentV1.js';
import type { SessionInputForgeEvidenceV1 } from './sessionInputForgeEvidenceV1.js';

/** Declared native data attachment; this is not the caller's plugin identity. */
export const SESSION_INPUT_FORGE_EVIDENCE_ATTACHMENT_IDENTITY_V1 = Object.freeze({
  pluginId: 'happier.app-context', localId: 'descriptive-evidence',
} as const);

/** Shared author value for evidence attachments, independent of their contribution identity. */
export function buildSessionInputForgeEvidenceAttachmentValueV1(evidence: SessionInputForgeEvidenceV1) {
  const forgeEvidence = { v: 1 as const, items: evidence.items.map((item) => ({
    source: { ...item.source }, author: { ...item.author }, text: item.text,
  })) };
  const named = evidence.items.find((item) => item.source.label.trim().length > 0)?.source.label.trim();
  const codePoints = named === undefined ? [] : Array.from(named);
  const label = named === undefined ? 'Selected evidence'
    : codePoints.length <= MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 ? named
      : `${codePoints.slice(0, MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 - 1).join('').trimEnd()}…`;
  return {
    // Keep the incumbent domain so moving ownership preserves existing draft keys.
    key: computeCanonicalDomainSeparatedDigest('happier:triage:composer-forge-evidence-key:v1', [JSON.stringify(forgeEvidence)]),
    value: { v: 1 as const, forgeEvidence },
    presentation: { label },
  };
}
