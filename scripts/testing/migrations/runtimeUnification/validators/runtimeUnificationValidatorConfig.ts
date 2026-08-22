export type RuntimeUnificationFamilyId =
  | 'MESSAGE-META-REGISTRY-1-deletion'
  | 'F5-permission-lifecycle'
  | 'F5-permission-host-ttl'
  | 'F5-jsonl-readline-client'
  | 'F5-tier2-acp-factory'
  | 'F5-review-engine-branch'
  | 'F5-review-comments-durable-storage'
  | 'F5-no-plugin-src-backend'
  | 'F5-direct-session-vocabulary'
  | 'F5-mcp-discovery-duplicate'
  | 'F5-auth-connected-services-duplicate'
  | 'F5-provider-keyed-owner-tree'
  | 'F5-execution-run-capability-residue'
  | 'F5-file-follow-duplicate'
  | 'F5-process-spawn-duplicate'
  | 'F5-runtime-failure-duplicate'
  | 'F5-context-compaction-duplicate'
  | 'F5-session-media-duplicate'
  | 'F5-session-media-capability-overclaim'
  | 'F5-jsonl-substrate-consumption'
  | 'F5-tier2-acp-consumption'
  | 'F5-permission-substrate-consumption'
  | 'F5-runtime-failure-substrate-consumption'
  | 'F5-session-media-substrate-consumption';

export interface ForbiddenPattern {
  label: string;
  pattern: RegExp;
}

export interface ForbiddenFamily {
  id: RuntimeUnificationFamilyId;
  canonicalOwner: string;
  owningPacket: string;
  roots: readonly string[];
  patterns?: readonly ForbiddenPattern[];
  pathPattern?: RegExp;
  filePathPattern?: RegExp;
  ignoredPaths?: readonly string[];
}

export interface RequiredEvidenceFamily {
  id: RuntimeUnificationFamilyId;
  canonicalOwner: string;
  owningPacket: string;
  roots: readonly string[];
  pattern: RegExp;
  minimumMatches: number;
}

const PROVIDER_ID_PATTERN = '(codex|claude|opencode|pi|ohmypi|gemini|auggie|copilot|kilo|kimi|kiro|qwen)';

export const CROSS_CUTTING_FORBIDDEN_FAMILIES: readonly ForbiddenFamily[] = Object.freeze([
  {
    id: 'MESSAGE-META-REGISTRY-1-deletion',
    canonicalOwner: 'plugin descriptor/projection message metadata',
    owningPacket: 'MESSAGE-META-REGISTRY-1-deletion',
    roots: ['apps', 'packages', 'scripts/migrations/extensions'],
    pathPattern: /(?:messageMetaRegistry|messageMetaOverrides)/,
    patterns: [
      {
        label: 'stale message meta registry or generated override artifact',
        pattern: /messageMetaRegistry|messageMetaOverrides/,
      },
    ],
  },
  {
    id: 'F5-permission-lifecycle',
    canonicalOwner: 'A.5c/A.5d shared permission lifecycle',
    owningPacket: 'A.5c-cancel-by-plugin,A.5d-permission-lifecycle-guardrail',
    roots: ['packages/plugins'],
    pathPattern: /^packages\/plugins\/[^/]+\/src\/agent\/utils\/permission[^/]*\.[cm]?[jt]sx?$/,
    patterns: [
      {
        label: 'permission lifecycle clone',
        pattern:
          /\b(?:permissionHandler|permissionLifecycle|permissionWaiters|requestRegistry|[A-Za-z]*RequestRegistry|[A-Za-z]*RequestStore|[A-Za-z]*WaiterMap|outstandingPermission|agentStateRequestStore|pending[A-Za-z]*Requests|localWaitersByRequestId|localWaiterSequence|cancelAll\s*\(|lateDecision)\b/,
      },
    ],
  },
  {
    id: 'F5-permission-host-ttl',
    canonicalOwner: 'A.5d no-host-TTL permission lifecycle guardrail',
    owningPacket: 'A.5d-permission-lifecycle-guardrail',
    roots: ['packages/plugins'],
    ignoredPaths: ['packages/plugins/claude/src/agent/permissions/bridge/localPermissionBridge.ts'],
    patterns: [
      {
        label: 'host-imposed permission timer',
        pattern: /\b(?:setTimeout|setInterval)\s*\(/,
      },
    ],
  },
  {
    id: 'F5-jsonl-readline-client',
    canonicalOwner: 'A.13e strict-LF JSONL substrate',
    owningPacket: 'A.13e-jsonl-strict-lf-substrate',
    roots: ['packages/plugins'],
    patterns: [
      {
        label: 'provider-local JSONL/readline client',
        pattern:
          /\b(?:FlatNdjsonManagedClient|PiNdjsonClient|node:readline|from ['"]readline|require\(['"]readline|import\(['"]readline|readline\/promises|createOhMyPiJsonlSessionStore)\b/,
      },
    ],
  },
  {
    id: 'F5-tier2-acp-factory',
    canonicalOwner: 'canonical Agent contributions through activate(api)',
    owningPacket: 'A.15.3',
    roots: ['packages/plugins'],
    patterns: [
      {
        label: 'plugin-local ACP factory',
        pattern:
          /\b(?:new\s+AcpBackend\s*\(|createAcpBackend\s*\(|registerAcpActivateHook|api\.registerProvider|api\.registerBackend\b|ProviderDefinitionV1|ExtensionProviderContributionV2)/,
      },
    ],
  },
  {
    id: 'F5-review-engine-branch',
    canonicalOwner: 'FD-0069 review-engine descriptors and execution-run profiles',
    owningPacket: 'FD-0069,R.0-review-comments-substrate',
    roots: ['apps', 'packages'],
    patterns: [
      {
        label: 'host/shared review-engine branch',
        pattern: /\b(?:runtimeCore\.review|nativeReviewEngines|target\.agentId\s*===\s*['"]coderabbit['"]|target\.agentId\s*===\s*['"]deepsec['"])\b/,
      },
    ],
  },
  {
    id: 'F5-review-comments-durable-storage',
    canonicalOwner: 'FD-0070/R.0 durable review-comments substrate',
    owningPacket: 'FD-0070,R.0-review-comments-substrate',
    roots: ['apps', 'packages'],
    patterns: [
      {
        label: 'review-comments durable storage bypass',
        pattern:
          /reviewComments.*accountSettings|accountSettings.*reviewComments|review_comments.*account_settings|reviews\.comments.*ctx\.storage|ctx\.storage.*reviews\.comments|snapshotBlobRef|hashOnlySnapshot|hash-only snapshot|reviewCommentsDraftsBySessionId.*durable|reviewCommentsDraftsByWorkspaceCacheKey.*durable|session-review-comments-draft-v1.*durable|workspace-review-comments-draft-v1.*durable|directWrite\s*:\s*true/,
      },
    ],
  },
  {
    id: 'F5-no-plugin-src-backend',
    canonicalOwner: 'plugin concern folders under packages/plugins/<id>/src/agent/** or a specific non-agent contribution folder',
    owningPacket: 'FD-0064,F.5',
    roots: ['packages/plugins'],
    pathPattern: /^packages\/plugins\/[^/]+\/src\/backend\//,
  },
  {
    id: 'F5-direct-session-vocabulary',
    canonicalOwner: 'A.15.4 external-session canonical naming',
    owningPacket: 'A.15.4',
    roots: ['packages/plugins', 'apps/cli/src/backends', 'packages/protocol/src/agents'],
    patterns: [
      {
        label: 'direct-session final vocabulary',
        pattern: /\b(?:directSessions|DirectSession|direct_session)\b/,
      },
    ],
  },
  {
    id: 'F5-mcp-discovery-duplicate',
    canonicalOwner: 'A.13c/FD-0065 manifest-first MCP contribution substrate',
    owningPacket: 'A.13c,FD-0065',
    roots: ['apps/cli/src/backends', 'packages/plugins'],
    patterns: [
      {
        label: 'provider-local MCP discovery substrate',
        pattern: /\b(?:detect[A-Z][A-Za-z]+McpServers|McpConfigDiscoveryFacet)\b/,
      },
    ],
  },
  {
    id: 'F5-auth-connected-services-duplicate',
    canonicalOwner: 'auth-and-services descriptors/materializers',
    owningPacket: 'A.11,A.11b,A.X-auth-services-rename,F.7',
    roots: ['packages/plugins'],
    filePathPattern: /^packages\/plugins\/[^/]+\/src\/agent\/(?:runtime|session|connectedServices)\//,
    patterns: [
      {
        label: 'plugin runtime/session auth service substrate duplicate',
        pattern: /\b(?:connectedServices|authService|oauth|tokenStore)\b/i,
      },
    ],
  },
  {
    id: 'F5-provider-keyed-owner-tree',
    canonicalOwner: 'generated bundled-plugin projection or plugin-owned provider facts',
    owningPacket: 'FD-0059,FD-0062,A.8x-plugin-sdk-catalog-closure',
    roots: ['apps/ui/sources/agents/providers', 'packages/agents/src/providers', 'packages/protocol/src/agents'],
    pathPattern: /^(?:apps\/ui\/sources\/agents\/providers|packages\/agents\/src\/providers|packages\/protocol\/src\/agents)\//,
  },
  {
    id: 'F5-execution-run-capability-residue',
    canonicalOwner: 'manifest.contributes.backends[].capabilities.executionRun.supported',
    owningPacket: 'FD-0066,A.8b-backend-capabilities-nested-migration',
    roots: ['packages/plugins'],
    patterns: [
      {
        label: 'stale broad executionRun capability residue',
        pattern: /capabilities:\s*\{[^}\n]*executionRun\s*:/,
      },
    ],
  },
  {
    id: 'F5-file-follow-duplicate',
    canonicalOwner: 'A.12.1 shared transcript/file-follow substrate',
    owningPacket: 'A.12.1-jsonl-follow-lifecycle',
    roots: ['packages/plugins'],
    patterns: [
      {
        label: 'plugin-local generic file-follow loop',
        pattern: /\b(?:fs\.watch|chokidar|tail.+follow|createReadStream)\b/,
      },
    ],
  },
  {
    id: 'F5-process-spawn-duplicate',
    canonicalOwner: 'managed runtime/process substrate',
    owningPacket: 'async-and-runtime-primitives,A.13p',
    roots: ['packages/plugins'],
    patterns: [
      {
        label: 'plugin-local generic process spawn',
        pattern: /\b(?:child_process|cross-spawn)\b|(?<![\w.])(?:spawn|execFile)\s*\(/,
      },
    ],
  },
  {
    id: 'F5-runtime-failure-duplicate',
    canonicalOwner: 'A.13d runtime issue recording and UI attention derivation',
    owningPacket: 'A.13d-session-runtime-errors',
    roots: ['apps', 'packages'],
    patterns: [
      {
        label: 'local failed-session attention heuristic',
        pattern: /\b(?:failedSessionBadge|sessionListFailure)\b/,
      },
      {
        label: 'legacy turn_aborted provider/runtime failure mapping',
        pattern: /\b(?:turn_aborted[^\n]*(?:status.*error|provider|runtime|process exited|quota|auth|usage|stream)|(?:status.*error|provider|runtime|process exited|quota|auth|usage|stream)[^\n]*turn_aborted)\b/i,
      },
    ],
  },
  {
    id: 'F5-runtime-failure-duplicate',
    canonicalOwner: 'A.13d runtime issue recording and UI attention derivation',
    owningPacket: 'A.13d-session-runtime-errors',
    roots: ['apps/ui/sources/components/pets', 'apps/ui/sources/sync/domains/session/listing'],
    patterns: [
      {
        label: 'tool failure mapped to parent session failed attention',
        pattern: /\b(?:tool\.state\s*===\s*['"]error['"][\s\S]{0,160}failed|tool[\s\S]{0,80}state[\s\S]{0,80}error[\s\S]{0,80}failed)\b/,
      },
    ],
  },
  {
    id: 'F5-context-compaction-duplicate',
    canonicalOwner: 'FD-0074/A.13i context-compaction event substrate',
    owningPacket: 'FD-0074,A.13i-context-compaction-events',
    roots: ['packages/plugins', 'apps/cli/src/backends', 'apps/cli/src/agent'],
    patterns: [
      {
        label: 'context-compaction duplicate schema or direct writer',
        pattern: new RegExp(
          `context-compaction[^\\n]*(?:presentation\\.status|Compaction completed|compactionSummary|summaryPreview|providerSummary|phase\\s*:\\s*['"]detected['"]|writeTranscript)|(?:presentation\\.status|Compaction completed|compactionSummary|summaryPreview|providerSummary|phase\\s*:\\s*['"]detected['"]|writeTranscript)[^\\n]*context-compaction`,
          'i',
        ),
      },
    ],
  },
  {
    id: 'F5-context-compaction-duplicate',
    canonicalOwner: 'FD-0074/A.13i context-compaction event substrate',
    owningPacket: 'FD-0074,A.13i-context-compaction-events',
    roots: ['apps/cli/src/agent', 'apps/ui/sources/components/sessions/transcript'],
    patterns: [
      {
        label: 'context-compaction provider-specific core or UI branch',
        pattern: new RegExp(
          `(?:providerId|agentId|backendId)\\s*===\\s*['"]${PROVIDER_ID_PATTERN}['"]`,
        ),
      },
    ],
  },
  {
    id: 'F5-session-media-duplicate',
    canonicalOwner: 'FD-0076/A.13j shared session-media ingestion and rendering substrate',
    owningPacket: 'FD-0076,A.13j-session-media,A.13j.5-session-media-validator-fences',
    roots: ['packages/plugins', 'apps/cli/src/backends', 'apps/ui/sources/agents', 'apps/ui/sources/components/sessions'],
    patterns: [
      {
        label: 'session-media duplicate storage/rendering path',
        pattern: new RegExp(
          `session_media\\.v1[\\s\\S]{0,240}(base64|b64|file://|https?://|/tmp/|/var/folders|providerUrl|publicUrl|backendId|summary|summaryPreview|providerSummary)|meta\\.happierAttachments[\\s\\S]{0,240}(provider-generated|generated|tool-artifact)|attachments\\.v1[\\s\\S]{0,240}(provider-generated|generated|tool-artifact)|path:\\s*['"]\\.happier/uploads|providerId\\s*===\\s*['"]${PROVIDER_ID_PATTERN}['"][\\s\\S]{0,160}(media|image)|autoAttach[A-Za-z]*Generated|generated[A-Za-z]*autoAttach`,
        ),
      },
    ],
  },
  {
    id: 'F5-session-media-capability-overclaim',
    canonicalOwner: 'source-real session-media output mapping through A.13j ingestion',
    owningPacket: 'FD-0076,A.13j-session-media,A.13j.5-session-media-validator-fences',
    roots: ['packages/plugins'],
    patterns: [
      {
        label: 'legacy native image-generation capability overclaim',
        pattern: /\bnativeImageGeneration\s*:\s*(?:true|['"]supported['"])/,
      },
    ],
  },
]);

export const CROSS_CUTTING_REQUIRED_EVIDENCE_FAMILIES: readonly RequiredEvidenceFamily[] = Object.freeze([
  {
    id: 'F5-jsonl-substrate-consumption',
    canonicalOwner: 'A.13e strict-LF JSONL/file-store substrate',
    owningPacket: 'A.13e-jsonl-strict-lf-substrate',
    roots: ['packages/plugins/pi', 'packages/plugins/ohmypi', 'apps/cli/src/agent/runtime'],
    pattern: /\b(?:attachJsonlLineReader|createJsonlRequestCorrelator|createTerminalBreadcrumbResolver)\b/g,
    minimumMatches: 3,
  },
  {
    id: 'F5-tier2-acp-consumption',
    canonicalOwner: 'canonical Agent contribution/runtime callbacks',
    owningPacket: 'A.15.3',
    roots: ['packages/plugins/auggie', 'packages/plugins/kimi', 'packages/plugins/kilo', 'packages/plugins/copilot'],
    pattern: /\b(?:contributes\.agents|AgentSessionRuntime|preflightSessionControls|permissionDecision)\b/g,
    minimumMatches: 4,
  },
  {
    id: 'F5-permission-substrate-consumption',
    canonicalOwner: 'shared SDK/host permission coordinator substrate',
    owningPacket: 'A.5c-cancel-by-plugin,A.5d-permission-lifecycle-guardrail',
    roots: ['packages/plugins/claude', 'packages/plugins/codex', 'packages/plugins/opencode', 'packages/plugins/pi', 'packages/plugins/ohmypi'],
    pattern: /\b(?:ctx\.session\.permissions|permissionRequestCoordinator|createExecutionRunPermissionHandler)\b/g,
    minimumMatches: 3,
  },
  {
    id: 'F5-runtime-failure-substrate-consumption',
    canonicalOwner: 'A.13d runtime issue recording and attention derivation',
    owningPacket: 'A.13d-session-runtime-errors',
    roots: ['apps', 'packages'],
    pattern: /\b(?:recordSessionRuntimeIssue|SessionRuntimeIssueV1|deriveSessionAttentionState)\b/g,
    minimumMatches: 3,
  },
  {
    id: 'F5-session-media-substrate-consumption',
    canonicalOwner: 'A.13j session-media ingestion/rendering substrate',
    owningPacket: 'A.13j-session-media,A.13j.5-session-media-validator-fences',
    roots: ['packages/protocol', 'apps/cli', 'apps/ui', 'packages/plugins'],
    pattern: /\b(?:session_media\.v1|SessionMediaItemV1|SessionMediaIngestionSource|persistSessionMedia|resolveSessionMediaTransferTarget)\b/g,
    minimumMatches: 5,
  },
]);
