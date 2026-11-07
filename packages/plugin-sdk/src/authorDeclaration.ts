// Author declarations may be shared immutable data. This projection does not
// change the canonical parsed Protocol descriptor or its validation rules.
// Kept as an import-free leaf so canonical API sources can use it without
// reaching the generated Protocol entrypoint barrel.
export type ReadonlyAuthorDeclaration<T> = T extends readonly (infer TItem)[]
  ? readonly ReadonlyAuthorDeclaration<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: ReadonlyAuthorDeclaration<T[TKey]> }
    : T;
