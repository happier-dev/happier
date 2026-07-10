/**
 * Options Parser Utilities
 * 
 * Utilities for parsing and formatting XML options blocks from agent responses.
 * Used for extracting and formatting <options><option>...</option></options> blocks.
 */

/**
 * Check if text has an incomplete options block (opening tag but no closing tag)
 * 
 * @param text - The text to check
 * @returns true if there's an opening <options> tag without a closing </options> tag
 */
export function hasIncompleteOptions(text: string): boolean {
  const hasOpeningTag = /<options>/i.test(text);
  const hasClosingTag = /<\/options>/i.test(text);
  return hasOpeningTag && !hasClosingTag;
}

/**
 * Parse XML options from text
 * Extracts <options><option>...</option></options> blocks and returns
 * the text without options and the parsed options array
 * 
 * @param text - The text containing options XML
 * @returns Object with text (without options) and options array
 */
export function parseOptionsFromText(text: string): { text: string; options: string[] } {
  // Match <options>...</options> block (multiline, non-greedy)
  const optionsRegex = /<options>\s*([\s\S]*?)\s*<\/options>/i;
  const match = text.match(optionsRegex);
  
  if (!match) {
    return { text: text.trim(), options: [] };
  }
  
  // Extract options block content
  const optionsBlock = match[1];
  
  // Parse individual <option> tags
  const optionRegex = /<option>(.*?)<\/option>/gi;
  const options: string[] = [];
  let optionMatch;
  
  while ((optionMatch = optionRegex.exec(optionsBlock)) !== null) {
    const optionText = optionMatch[1].trim();
    if (optionText) {
      options.push(optionText);
    }
  }
  
  // Remove options block from text
  const textWithoutOptions = text.replace(optionsRegex, '').trim();
  
  return { text: textWithoutOptions, options };
}

/**
 * Format options array as XML string
 * 
 * @param options - Array of option strings
 * @returns XML formatted string with <options> block
 */
export function formatOptionsXml(options: string[]): string {
  if (options.length === 0) {
    return '';
  }
  return '\n<options>\n' + options.map(opt => `    <option>${opt}</option>`).join('\n') + '\n</options>';
}

/**
 * Format assistant text for terminal display
 * Replaces an <options>...</options> XML block with a readable numbered list
 * so terminal surfaces (which have no tappable option buttons) do not show raw XML.
 *
 * @param text - The assistant text potentially containing an options XML block
 * @returns The text with the options block rendered as a numbered list
 */
export function formatTextWithOptionsForTerminal(text: string): string {
  const { text: textWithoutOptions, options } = parseOptionsFromText(text);
  if (options.length === 0) {
    return text;
  }
  const numberedList = options.map((option, index) => `  ${index + 1}. ${option}`).join('\n');
  const optionsBlock = `Options:\n${numberedList}`;
  return textWithoutOptions.length > 0 ? `${textWithoutOptions}\n\n${optionsBlock}` : optionsBlock;
}
