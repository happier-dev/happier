import * as React from 'react';
import type { BuiltinWorkflowIconV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { Icon, type IconName, type IconProps } from '@/components/ui/icons/Icon';

/** The catalog's mark vocabulary, each a real glyph of this host (owner 2026-11-12: one mark per built-in). */
const builtinMarks = {
    target: 'target',
    'shield-check': 'shield-check',
    'list-checks': 'list-checks',
    'git-pull-request': 'git-pull-request',
    users: 'users',
    'git-branch': 'git-branch',
    'seal-check': 'seal-check',
    scales: 'scales',
    'scan-search': 'magnifying-glass',
} as const satisfies Record<BuiltinWorkflowIconV1, IconName>;

/** A built-in workflow's own mark, in its navigation row, library row, pickers and run fold. */
export function WorkflowBuiltinMark({ icon, ...iconProps }: Readonly<{ icon: BuiltinWorkflowIconV1 }> & Omit<IconProps, 'name'>) {
    return <Icon name={builtinMarks[icon]} {...iconProps} />;
}
