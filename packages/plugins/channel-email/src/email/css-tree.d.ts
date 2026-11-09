// css-tree 3.2 publishes these subpaths; @types/css-tree only declares its root.
// Reuse those signatures instead of copying the parser/AST contract.
declare module 'css-tree/parser' {
  import { parse } from 'css-tree';
  export default parse;
}
declare module 'css-tree/generator' {
  import { generate } from 'css-tree';
  export default generate;
}
declare module 'css-tree/walker' {
  import { walk } from 'css-tree';
  export default walk;
}
declare module 'css-tree/utils' {
  export { ident } from 'css-tree';
}
