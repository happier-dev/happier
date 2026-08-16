# Happier i18n (Object-Based Implementation)

A type-safe internationalization system using an object-based approach with functions and constants, accessed via the familiar `t('key', params)` API format.

## Overview

This implementation uses **no external libraries** and provides:
- **Full TypeScript type safety** with IntelliSense support
- **Object parameters** with strict typing: `t('welcome', { name: 'Steve' })`
- **Mixed value types**: String constants and functions in the same object
- **Smart pluralization** and complex logic built into translation functions
- **Compile-time validation** of keys and parameter shapes

## Architecture

### Translation Values
Translation values can be either:
1. **String constants**: `'Cancel'` for static text
2. **Functions**: `({ name }: { name: string }) => \`Welcome, ${name}!\`` for dynamic text

### Type Safety
- **Keys are validated**: Only existing keys can be used
- **Parameters are enforced**: Required/optional parameters are type-checked
- **Object shapes are validated**: Parameter objects must match expected structure
- **Return types are guaranteed**: Always returns a string

## Usage Examples

### Basic Usage

```typescript
import { t } from '@/text';

// ✅ Simple constants (no parameters)
t('common.cancel')              // "Cancel"
t('settings.title')             // "Settings"
t('session.connected')          // "Connected"

// ✅ Functions with required object parameters
t('common.welcome', { name: 'Steve' })           // "Welcome, Steve!"
t('common.itemCount', { count: 5 })              // "5 items"
t('time.minutesAgo', { count: 1 })               // "1 minute ago"

// ✅ Multiple parameters
t('errors.fieldError', { field: 'Email', reason: 'Invalid format' })
t('auth.loginAttempt', { attempt: 2, maxAttempts: 3 })

// ✅ Optional parameters
t('time.at', { time: '3:00 PM' })                // "3:00 PM"
t('time.at', { time: '3:00 PM', date: 'Monday' }) // "3:00 PM on Monday"
```

### Advanced Usage

```typescript
// Complex logic with multiple parameters
t('session.summary', { files: 3, messages: 10, duration: 5 })
// → "3 files, 10 messages in 5 minutes"

// Smart file size formatting
t('files.fileSize', { bytes: 1536 })  // "2 KB"
t('files.fileSize', { bytes: 500 })   // "500 B"

// Git status with conditional logic
t('git.branchStatus', { branch: 'main', ahead: 2, behind: 0 })
// → "On branch main, 2 commits ahead"

// Strict enum-like typing
t('common.greeting', { name: 'Steve', time: 'morning' })  // time must be 'morning' | 'afternoon' | 'evening'
```

### Type Safety Examples

```typescript
// ❌ These will cause TypeScript errors:
t('common.cancel', { extra: 'param' })   // Error: Expected 0 arguments
t('common.welcome')                      // Error: Missing required parameter
t('common.welcome', { wrongKey: 'x' })   // Error: Object must have 'name' property
t('common.welcome', { name: 123 })       // Error: 'name' must be string
t('invalid.key')                         // Error: Key doesn't exist
```

## Files Structure

### `translations/en.ts`
Contains the canonical English translation object with mixed string/function values:

```typescript
export const en = {
    common: {
        cancel: 'Cancel',                    // String constant
        welcome: ({ name }: { name: string }) => `Welcome, ${name}!`,  // Function
        itemCount: ({ count }: { count: number }) =>  // Smart pluralization
            count === 1 ? '1 item' : `${count} items`,
    },
    // ... more categories
} as const;
```

### `_types.ts`
Contains the TypeScript types derived from the English translation structure.

This keeps the canonical translation object (`translations/en.ts`) separate from the type-level API:
- `Translations` / `TranslationStructure` are derived from `en` and used to type-check other locales.
- `TranslationKey` / `TranslationParams<K>` are derived from `Translations` (in `index.ts`) to type `t(...)`.

### `index.ts`
Main module with the `t` function and utilities:
- `t()` - Main translation function with strict typing
- `hasTranslation()` - Check if a key exists
- `getTranslationValue()` - Get raw value (debugging)

## Key Benefits

### 1. **Familiar API**
Uses the standard `t('key', params)` format that developers expect.

### 2. **Maximum Type Safety**
```typescript
// TypeScript knows exactly what parameters each key needs
type WelcomeParams = TranslationParams<'common.welcome'>;  // { name: string }
type CancelParams = TranslationParams<'common.cancel'>;    // void
```

### 3. **Object Parameters**
Clean, self-documenting parameter syntax:
```typescript
// Instead of positional: t('greeting', 'Steve', 'morning')
// Use named objects: t('greeting', { name: 'Steve', time: 'morning' })
```

### 4. **Logic in Translations**
Complex formatting and pluralization logic lives with the text:
```typescript
fileSize: ({ bytes }: { bytes: number }) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}
```

### 5. **Performance**
- No string interpolation parsing
- Direct function calls
- Tree-shakeable (unused translations can be eliminated)
- No external dependencies

### 6. **Developer Experience**
- Full IntelliSense support
- Compile-time error catching
- Self-documenting parameter names
- Easy debugging with utility functions

## Migration Guide

If migrating from an interpolation-based system:

```typescript
// Old: String interpolation
t('welcome', { name: 'Steve' })  // Parsed "{name}" at runtime

// New: Same API, but with functions
t('welcome', { name: 'Steve' })  // Direct function call, same result
```

The API stays the same, but you get:
- Better performance (no parsing)
- Stronger typing (object shape validation)  
- More flexibility (complex logic in functions)

## Adding New Translations

1. **Add to `translations/en.ts`**:
```typescript
// String constant
newConstant: 'My New Text',

// Function with parameters
newFunction: ({ user, count }: { user: string; count: number }) =>
    `Hello ${user}, you have ${count} items`,
```

2. **TypeScript automatically updates** - the new keys become available with full type checking.

3. **Use immediately**:
```typescript
t('category.newConstant')                        // "My New Text"
t('category.newFunction', { user: 'Steve', count: 5 })  // "Hello Steve, you have 5 items"
```

## Best Practices

### Parameter Design
```typescript
// ✅ Good: Use descriptive parameter names
messageFrom: ({ sender }: { sender: string }) => `Message from ${sender}`,

// ✅ Good: Use optional parameters when appropriate
at: ({ time, date }: { time: string; date?: string }) =>
    date ? `${time} on ${date}` : time,

// ✅ Good: Use union types for strict validation
greeting: ({ name, time }: { name: string; time: 'morning' | 'afternoon' | 'evening' }) =>
    `Good ${time}, ${name}!`,
```

### Complex Logic
```typescript
// ✅ Good: Put complex logic in the translation function
statusMessage: ({ files, online, syncing }: {
    files: number;
    online: boolean;
    syncing: boolean;
}) => {
    if (!online) return 'Offline';
    if (syncing) return 'Syncing...';
    return files === 0 ? 'No files' : `${files} files ready`;
}
```

## Adding a language

Locale files are ~10k lines of TypeScript containing typechecked functions and `${...}`
interpolations, so they are generated rather than hand-written. The full procedure, the tooling and
the per-language style rules live in **[`translations/README.md`](./translations/README.md)**.

In short:

```bash
cd apps/ui
yarn i18n:locale:extract -- --locale <code> --out /tmp/<code>.todo.json
yarn i18n:locale:verify  -- --translations /tmp/<code>.json
yarn i18n:locale:build   -- --locale <code> --translations /tmp/<code>.json
```

Then register the locale in three places: `_all.ts` (the code and its `nativeName`), `i18n.ts` (a
thunk in `TRANSLATION_TREE_BY_LANGUAGE`, so only the active language is materialised) and
`i18n.integrity.test.ts` (the locale lists, so it is held to the same completeness bar as every
other language). The language picker is data-driven off `SUPPORTED_LANGUAGES` and needs no change.

The tools are in `apps/ui/tools/i18n/`. They rewrite only the interior of string and template
literals — never the surrounding structure — and `localeLiterals.test.ts` pins that with a
round-trip over every locale file.
