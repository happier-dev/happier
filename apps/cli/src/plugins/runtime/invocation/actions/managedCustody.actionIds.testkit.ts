export const roles = ['acquire', 'bootstrap', 'exec', 'putFile', 'power', 'destroy', 'rebuild', 'resize'] as const;

export function roleActionId(role: typeof roles[number] | 'reconcile' | 'snapshot' | 'stream') {
    return role === 'putFile' ? 'put-file' : role;
}

export const managedCustodyDefaultActionIds = [...roles.map(roleActionId), 'check', 'options', 'inspect', 'ordinary'] as const;
