type ExternalSessionFieldDeclaration = Readonly<{ name: string }>;
type ExternalSessionWhenDeclaration = Readonly<{ field: string; equals: string }>;
type ExternalSessionSchemaRefinementDeclaration =
  | Readonly<{
      kind: 'requiresWhenEquals';
      field: string;
      when: ExternalSessionWhenDeclaration;
    }>
  | Readonly<{
      kind: 'forbidsWhenEquals';
      fields: readonly string[];
      when: ExternalSessionWhenDeclaration;
    }>;
type ExternalSessionKeySegmentDeclaration =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'field'; field: string }>
  | Readonly<{ kind: 'homeMode'; field: string }>
  | Readonly<{ kind: 'conditionalField'; field: string; when: ExternalSessionWhenDeclaration }>
  | Readonly<{
      kind: 'connectedServiceScope';
      groupField: string;
      profileField: string;
      when: ExternalSessionWhenDeclaration;
    }>;
type ExternalSessionInstanceDeclaration =
  | Readonly<{ kind: 'default'; constants: Readonly<Record<string, unknown>> }>
  | Readonly<{
      kind: 'connectedServiceProfiles';
      constants: Readonly<Record<string, unknown>>;
      fields: Readonly<{ serviceId: string; profileId: string }>;
    }>;

export type BackendExternalSessionSourceReferenceDeclaration = Readonly<{
  sourceKind: string;
  schema: Readonly<{
    fields: readonly ExternalSessionFieldDeclaration[];
    refinements?: readonly ExternalSessionSchemaRefinementDeclaration[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDeclaration[];
  }>;
  instances?: readonly ExternalSessionInstanceDeclaration[];
}>;

export type BackendExternalSessionSourceReferenceIssue = Readonly<{
  path: readonly (string | number)[];
  fieldName: string;
}>;

function addReferenceIssue(
  issues: BackendExternalSessionSourceReferenceIssue[],
  declaredFields: ReadonlySet<string>,
  fieldName: string,
  path: readonly (string | number)[],
): void {
  if (declaredFields.has(fieldName)) return;
  issues.push({ path, fieldName });
}

function addWhenReferenceIssue(
  issues: BackendExternalSessionSourceReferenceIssue[],
  declaredFields: ReadonlySet<string>,
  when: ExternalSessionWhenDeclaration,
  path: readonly (string | number)[],
): void {
  addReferenceIssue(issues, declaredFields, when.field, path);
}

export function findBackendExternalSessionSourceReferenceIssues(
  declaration: BackendExternalSessionSourceReferenceDeclaration,
): readonly BackendExternalSessionSourceReferenceIssue[] {
  const declaredFields = new Set(declaration.schema.fields.map((field) => field.name));
  const issues: BackendExternalSessionSourceReferenceIssue[] = [];

  for (const [index, refinement] of (declaration.schema.refinements ?? []).entries()) {
    if (refinement.kind === 'requiresWhenEquals') {
      addReferenceIssue(issues, declaredFields, refinement.field, ['schema', 'refinements', index, 'field']);
      addWhenReferenceIssue(issues, declaredFields, refinement.when, ['schema', 'refinements', index, 'when', 'field']);
      continue;
    }
    for (const [fieldIndex, field] of refinement.fields.entries()) {
      addReferenceIssue(issues, declaredFields, field, ['schema', 'refinements', index, 'fields', fieldIndex]);
    }
    addWhenReferenceIssue(issues, declaredFields, refinement.when, ['schema', 'refinements', index, 'when', 'field']);
  }

  for (const [index, segment] of declaration.key.segments.entries()) {
    if (segment.kind === 'literal') continue;
    if (segment.kind === 'field' || segment.kind === 'homeMode') {
      addReferenceIssue(issues, declaredFields, segment.field, ['key', 'segments', index, 'field']);
      continue;
    }
    if (segment.kind === 'conditionalField') {
      addReferenceIssue(issues, declaredFields, segment.field, ['key', 'segments', index, 'field']);
      addWhenReferenceIssue(issues, declaredFields, segment.when, ['key', 'segments', index, 'when', 'field']);
      continue;
    }
    addReferenceIssue(issues, declaredFields, segment.groupField, ['key', 'segments', index, 'groupField']);
    addReferenceIssue(issues, declaredFields, segment.profileField, ['key', 'segments', index, 'profileField']);
    addWhenReferenceIssue(issues, declaredFields, segment.when, ['key', 'segments', index, 'when', 'field']);
  }

  for (const [index, instance] of (declaration.instances ?? []).entries()) {
    for (const fieldName of Object.keys(instance.constants)) {
      addReferenceIssue(issues, declaredFields, fieldName, ['instances', index, 'constants', fieldName]);
    }
    if (instance.kind === 'default') continue;
    addReferenceIssue(issues, declaredFields, instance.fields.serviceId, ['instances', index, 'fields', 'serviceId']);
    addReferenceIssue(issues, declaredFields, instance.fields.profileId, ['instances', index, 'fields', 'profileId']);
  }

  return issues;
}

export function assertBackendExternalSessionSourceReferences(
  declaration: BackendExternalSessionSourceReferenceDeclaration,
): void {
  const issues = findBackendExternalSessionSourceReferenceIssues(declaration);
  if (issues.length === 0) return;
  const first = issues[0];
  throw new Error(
    `Invalid external-session source declaration for ${declaration.sourceKind}: undeclared field "${first?.fieldName ?? ''}"`,
  );
}
