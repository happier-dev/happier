import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

type NativeCommandDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } };

/** The Codex producer owns the translation to its native response codec. */
export function buildCodexPermissionChoices(requirementId: string, availableDecisions?: unknown): NativePermissionChoicesV1 {
  const available = Array.isArray(availableDecisions)
    ? availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel'];
  const choices: NativePermissionChoicesV1['choices'][number][] = [];
  for (const [index, value] of available.entries()) {
    if (value === 'accept') choices.push({ id: value, label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } });
    else if (value === 'acceptForSession') choices.push({ id: value, label: 'Allow for this session', decision: 'approved_for_session', scope: 'session', response: { approved: true, decision: 'approved_for_session' } });
    else if (value === 'decline') choices.push({ id: value, label: 'Deny', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } });
    else if (value === 'cancel') choices.push({ id: value, label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } });
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const amendment = (value as Record<string, unknown>).acceptWithExecpolicyAmendment;
      const command = amendment && typeof amendment === 'object' && !Array.isArray(amendment)
        ? (amendment as Record<string, unknown>).execpolicy_amendment : undefined;
      if (Array.isArray(command) && command.every((part): part is string => typeof part === 'string')) {
        choices.push({ id: `execpolicy:${index}`, label: 'Allow this command rule', decision: 'approved_execpolicy_amendment', scope: 'localPersistent',
          rulePreview: command.join(' '), response: { approved: true, decision: 'approved_execpolicy_amendment', execPolicyAmendment: { command } } });
      }
    }
  }
  return { requirementId, source: 'codex', choices };
}

export function resolveCodexNativeCommandDecision(choice: NativePermissionChoicesV1['choices'][number]): NativeCommandDecision {
  switch (choice.decision) {
    case 'approved_execpolicy_amendment':
      return { acceptWithExecpolicyAmendment: { execpolicy_amendment: choice.response.execPolicyAmendment!.command } };
    case 'approved_for_session': return 'acceptForSession';
    case 'approved': return 'accept';
    case 'denied': return 'decline';
    case 'abort': return 'cancel';
  }
}
