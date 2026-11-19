import { z, type core } from '../../zodRuntimePolicy.js';
import type { ErrorObject } from 'ajv';
import type { PluginJsonSchemaValidator } from '../../plugins/actions/protocolComposableSchema.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BotFaceShapeConstraintSchema, type BotFaceShapeConstraint } from '../../sessions/identity/botFaceShapeValidation.js';
import { INVITATION_TOKEN_EXPECTED_MESSAGE } from '../../teams/invitationToken.js';

import type { ActionExecuteFailure } from '../actionExecutionResult.js';

type JsonPrimitive = string | number | boolean | null;
type ActionInputIssue = Readonly<{
  code: string;
  path: readonly (string | number)[];
  message?: string;
  expected?: string;
  acceptedValues?: readonly JsonPrimitive[];
  constraint?: BotFaceShapeConstraint;
}>;

/** Diagnostic facts are additive-open/drop; input-bearing extras never survive forwarding. */
export const ActionInputIssueSchema = lazyZodSchema(() => z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.optional(z.string()),
  expected: z.optional(z.string()),
  acceptedValues: z.optional(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  constraint: z.optional(BotFaceShapeConstraintSchema),
}));

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value);
}

const { localeError: formatSchemaIssue } = z.locales.en();

const safeRefinementMessage = Symbol('safe Action input refinement message');

/** Declare a schema-authored repair message. The message must be independent of the submitted input. */
export function actionInputRefinementMessage(message: string, path?: (string | number)[]) {
  return { message, path, params: { [safeRefinementMessage]: message } };
}

/** Use schema-authored repair messages and defaults that omit the submitted input. */
function projectIssueMessage(issue: core.$ZodIssue): string {
  if (issue.code === 'custom' && issue.params) {
    const message: unknown = Reflect.get(issue.params, safeRefinementMessage);
    if (typeof message === 'string') return message;
  }
  if (issue.code === 'invalid_type') return `Expected ${issue.expected}`;
  if (issue.code === 'unrecognized_keys') return 'Unrecognized input fields';
  const formatted = formatSchemaIssue({ ...issue, input: undefined });
  return typeof formatted === 'string' ? formatted : formatted?.message ?? 'Invalid input';
}

function projectIssue(issue: core.$ZodIssue, parentPath: readonly (string | number)[] = []): ActionInputIssue[] {
  if (issue.message === 'theme_document_invalid') {
    return [{ code: 'theme_document_invalid', path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number') }];
  }
  if (issue.message === 'invitation_token_expected') {
    return [{ code: 'invitation_token_expected', path: ['token'], message: INVITATION_TOKEN_EXPECTED_MESSAGE }];
  }
  const values = issue.code === 'invalid_value' ? issue.values
    : issue.code === 'invalid_union' && 'options' in issue ? issue.options : undefined;
  const acceptedValues = values?.filter(isJsonPrimitive);
  const path = [...parentPath, ...issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')];
  const constraint = issue.code === 'custom' ? BotFaceShapeConstraintSchema.safeParse(issue.params?.constraint) : undefined;
  return [{
    code: issue.code,
    path,
    message: projectIssueMessage(issue),
    ...(issue.code === 'invalid_type' ? { expected: issue.expected } : {}),
    ...(issue.code === 'invalid_format' && issue.format === 'starts_with'
      && 'prefix' in issue && typeof issue.prefix === 'string'
      ? { expected: `starts_with ${JSON.stringify(issue.prefix)}` } : {}),
    ...(acceptedValues?.length ? { acceptedValues } : {}),
    ...(constraint?.success ? { constraint: constraint.data } : {}),
  }, ...(issue.code === 'invalid_union' ? issue.errors.flatMap(branch => branch.flatMap(child => projectIssue(child, path))) : [])];
}

/** Never echo rejected values, unknown-key lists, or unverified custom issue prose. */
export function actionInputValidationFailure(error: core.$ZodError): ReturnType<typeof actionInputIssueFailure> {
  return actionInputIssueFailure(...projectActionInputIssues(error));
}

/** Shared content-free repair facts for Action results and Voice refusals. */
export function projectActionInputIssues(error: core.$ZodError): readonly ActionInputIssue[] {
  return error.issues.flatMap(issue => projectIssue(issue));
}

/** Read the canonical compiler's last failure; never revalidate or copy input/prose. */
export function projectActionInputJsonSchemaIssues(
  validate: PluginJsonSchemaValidator,
  schema: object,
  input: unknown,
): readonly ActionInputIssue[] {
  // The Protocol JSON Schema compiler owns this AJV error-bag boundary.
  const errors = (validate as PluginJsonSchemaValidator & { errors?: readonly ErrorObject<string, Record<string, unknown>>[] | null }).errors;
  return (errors ?? []).map(error => {
    let cursor = input;
    const path = error.instancePath === '' ? [] : error.instancePath.slice(1).split('/').map(encoded => {
      const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      const key = Array.isArray(cursor) && /^\d+$/u.test(segment) ? Number(segment) : segment;
      cursor = cursor !== null && typeof cursor === 'object' ? Reflect.get(cursor, key) : undefined;
      return key;
    });
    if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') path.push(error.params.missingProperty);
    let constraint: unknown = schema;
    for (const encoded of error.schemaPath.slice(2).split('/')) {
      constraint = constraint !== null && typeof constraint === 'object'
        ? Reflect.get(constraint, encoded.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
    }
    const acceptedValues = error.keyword === 'enum' && Array.isArray(constraint) ? constraint.filter(isJsonPrimitive)
      : error.keyword === 'const' && isJsonPrimitive(constraint) ? [constraint] : undefined;
    const expected = error.keyword === 'type' && typeof error.params.type === 'string' ? error.params.type
      : error.keyword === 'required' ? 'nonoptional' : undefined;
    // AJV prose and additionalProperty can carry rejected content; use only the declared repair facts.
    const message = error.keyword === 'required' ? 'Required input field'
      : expected ? `Expected ${expected}`
        : acceptedValues?.length ? `Expected one of ${acceptedValues.map(value => JSON.stringify(value)).join(', ')}`
          : error.keyword === 'additionalProperties' ? 'Unrecognized input fields' : 'Invalid input';
    return { code: error.keyword, path, message,
      ...(expected === undefined ? {} : { expected }),
      ...(acceptedValues?.length ? { acceptedValues } : {}),
    };
  });
}

/** Semantic checks use the same content-free repair envelope as schema validation. */
export function actionInputIssueFailure(...issues: readonly ActionInputIssue[]) {
  if (issues.some(issue => issue.code === 'theme_document_invalid')) {
    return { ok: false, errorCode: 'theme_document_invalid', error: 'theme_document_invalid' } satisfies ActionExecuteFailure;
  }
  if (issues.some(issue => issue.code === 'invitation_token_expected')) {
    return { ok: false, errorCode: 'invitation_token_expected', error: INVITATION_TOKEN_EXPECTED_MESSAGE } satisfies ActionExecuteFailure;
  }
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', details: { issues: issues.map(issue => ActionInputIssueSchema.parse({
    ...issue,
    ...(issue.acceptedValues === undefined ? {} : { acceptedValues: issue.acceptedValues.filter(isJsonPrimitive) }),
  })) } } satisfies ActionExecuteFailure;
}
