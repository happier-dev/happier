export function serializeActionSpec(spec: any): unknown {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description ?? null,
    safety: spec.safety,
    placements: spec.placements ?? [],
    slash: spec.slash ?? null,
    bindings: spec.bindings ?? null,
    examples: spec.examples ?? null,
    surfaces: spec.surfaces,
    inputHints: spec.inputHints ?? null,
  };
}

