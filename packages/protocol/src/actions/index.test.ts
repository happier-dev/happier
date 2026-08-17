import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ActionInputPathSchema,
  ActionInputPredicateSchema,
  ActionInputPrimitiveSchema,
  evaluateActionInputPredicate,
  type ActionInputPredicate,
} from './index.js';
import {
  ActionInputPathSchema as canonicalActionInputPathSchema,
  ActionInputPredicateSchema as canonicalActionInputPredicateSchema,
  ActionInputPrimitiveSchema as canonicalActionInputPrimitiveSchema,
  evaluateActionInputPredicate as canonicalEvaluateActionInputPredicate,
  type ActionInputPredicate as CanonicalActionInputPredicate,
} from './actionInputPredicates.js';

describe('Protocol Action public barrel', () => {
  it('projects the canonical Action input predicate contract without a second owner', () => {
    type NestedActionInputPredicate = {
      op: 'not';
      predicate: {
        op: 'eq';
        path: string;
        value: null;
      };
    };

    expect(ActionInputPathSchema).toBe(canonicalActionInputPathSchema);
    expect(ActionInputPrimitiveSchema).toBe(canonicalActionInputPrimitiveSchema);
    expect(ActionInputPredicateSchema).toBe(canonicalActionInputPredicateSchema);
    expect(evaluateActionInputPredicate).toBe(canonicalEvaluateActionInputPredicate);
    expectTypeOf<ActionInputPredicate>().toEqualTypeOf<CanonicalActionInputPredicate>();
    expectTypeOf<NestedActionInputPredicate>().toMatchTypeOf<ActionInputPredicate>();
    expectTypeOf<{ op: 'bogus' }>().not.toMatchTypeOf<ActionInputPredicate>();
  });
});
