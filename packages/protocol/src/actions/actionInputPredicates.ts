/** Action predicates use the neutral field predicate owner. */
export {
  InputPathSchema as ActionInputPathSchema,
  type InputPath as ActionInputPath,
  InputPrimitiveSchema as ActionInputPrimitiveSchema,
  type InputPrimitive as ActionInputPrimitive,
  type InputPredicate as ActionInputPredicate,
  InputPredicateSchema as ActionInputPredicateSchema,
  readInputPath as readActionInputPath,
  evaluateInputPredicate as evaluateActionInputPredicate,
} from '../inputs/inputPredicates.js';
