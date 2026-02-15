declare module 'bun:sqlite' {
  // Bun-only module. In Node builds we provide this stub so TypeScript can typecheck.
  export const Database: any;
}

