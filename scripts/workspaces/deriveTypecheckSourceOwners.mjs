/** Keep independent declaration producers and private namespace/JSX sources in
 * their compiler environment. Contextual source leaves retain their importer.
 * Boundary edges become project references, never a second alias lookup.
 */
export function deriveTypecheckSourceOwners({ original, sourceRoots, testRoots, contextFor, dependenciesFor, ambientFor }) {
  const nodesByContext = new Map();
  const selections = new Map();
  const pending = [];
  const queued = new Set();
  const sources = new Set();
  const nodeFor = (file, context) => {
    const owner = contextFor(file, context);
    if (!nodesByContext.has(owner)) nodesByContext.set(owner, new Map());
    const nodes = nodesByContext.get(owner);
    if (!nodes.has(file)) nodes.set(file, { file, owner, parents: new Set() });
    return nodes.get(file);
  };
  const select = node => {
    if (!selections.has(node.owner)) selections.set(node.owner, { owner: node.owner, seeds: new Set(), files: new Set(), references: new Map() });
    const selection = selections.get(node.owner);
    if (!selection.seeds.has(node.file)) {
      selection.seeds.add(node.file);
      if (!queued.has(selection)) {
        queued.add(selection);
        pending.push(selection);
      }
    }
  };
  const walk = (seeds, owner, files, references) => {
    const visited = new Set();
    const stack = seeds.map(file => nodeFor(file, owner));
    while (stack.length) {
      const node = stack.pop();
      if (visited.has(node) || files.has(node.file)) continue;
      visited.add(node);
      if (node.owner !== owner) {
        references?.set(node, { configPath: node.owner.configPath, file: node.file });
        select(node);
        continue;
      }
      if (!node.dependencies) {
        const dependencies = dependenciesFor(node.file, owner);
        if (!dependencies) continue;
        node.dependencies = dependencies.map(file => nodeFor(file, owner));
        for (const child of node.dependencies) child.parents.add(node);
      }
      files.add(node.file);
      for (const dependency of node.dependencies) stack.push(dependency);
    }
  };
  walk(sourceRoots, original, sources);
  // Test implementation roots are checked by their noEmit programs; only
  // implementations needed by another host require source declarations.
  walk(testRoots, original, new Set());
  const prepared = new Map();
  for (let index = 0; index < pending.length; index++) {
    const selection = pending[index];
    queued.delete(selection);
    if (selection.owner === original) {
      walk([...selection.seeds], original, sources);
      continue;
    }
    if (!prepared.has(selection.owner)) prepared.set(selection.owner, ambientFor(selection.owner));
    const ambient = prepared.get(selection.owner);
    walk([...selection.seeds, ...ambient.producerInputs, ...ambient.declarationRoots], selection.owner, selection.files, selection.references);
  }
  const reachableOwners = new Map();
  const labels = new Map();
  const propagation = [];
  const label = (node, owner) => {
    if (!labels.has(node)) labels.set(node, new Set());
    if (labels.get(node).has(owner)) return;
    labels.get(node).add(owner);
    propagation.push([node, owner]);
  };
  for (const [owner, nodes] of nodesByContext) {
    if (owner === original) continue;
    for (const node of nodes.values()) label(node, owner);
  }
  for (let index = 0; index < propagation.length; index++) {
    const [node, owner] = propagation[index];
    for (const parent of node.parents) label(parent, owner);
  }
  for (const file of testRoots) reachableOwners.set(file, labels.get(nodeFor(file, original)) ?? new Set());
  const imports = new Map([...sources].map(file => [file, (nodeFor(file, original).dependencies ?? [])
    .filter(node => node.owner === original).map(node => node.file)]));
  return {
    sources: [...sources], imports, reachableOwners,
    sourceReferences: new Map([...sources].map(file => [file, (nodeFor(file, original).dependencies ?? [])
      .filter(node => node.owner !== original).map(node => ({ configPath: node.owner.configPath, file: node.file }))])),
    foreignProjects: [...selections.values()].filter(selection => selection.owner !== original).map(selection => ({
      configPath: selection.owner.configPath, files: selection.files, references: [...selection.references.values()],
      ambientInputs: prepared.get(selection.owner).ambientInputsFor([...selection.seeds]),
    })),
  };
}
