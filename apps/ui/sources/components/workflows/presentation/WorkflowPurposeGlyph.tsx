import * as React from 'react';
import type { BuiltinWorkflowPurposeV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { Icon, type IconName, type IconProps } from '@/components/ui/icons/Icon';

/** One purpose mark for a built-in, in both its navigation row and library row. */
const purposeGlyphs = {
    goal: 'target',
    review: 'shield-check',
    plan: 'list-checks',
    pull_request: 'git-pull-request',
} as const satisfies Record<BuiltinWorkflowPurposeV1, IconName>;

export function WorkflowPurposeGlyph({ purpose, ...iconProps }: Readonly<{ purpose: BuiltinWorkflowPurposeV1 }> & Omit<IconProps, 'name'>) {
    return <Icon name={purposeGlyphs[purpose]} {...iconProps} />;
}
