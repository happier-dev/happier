/** Copy for the Media stage and the File viewer bodies (image, SVG, PDF, video, audio, binary). */
export type FileViewerTranslations = Readonly<{
  /** The annotator and the stage's Annotate mode (P2, MIS §3 and §8). */
  annotate: Readonly<{
    annotate: string;
    tools: Readonly<Record<'title' | 'select' | 'arrow' | 'rectangle' | 'ellipse' | 'freehand' | 'highlighter' | 'text' | 'step' | 'blur' | 'crop' | 'element', string>>;
    colourAndStroke: string;
    colour: string;
    colours: Readonly<Record<'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'ink', string>>;
    stroke: Readonly<Record<'title' | 's' | 'm' | 'l', string>>;
    textSize: Readonly<Record<'title' | 's' | 'm' | 'l', string>>;
    undo: string;
    redo: string;
    nothingToUndo: string;
    nothingToRedo: string;
    textMark: string;
    revert: string;
    done: string;
    discardPrompt: string;
    keepEditing: string;
    discard: string;
    /** The caption's tail under a composer picture in Annotate mode. */
    editableUntilSend: string;
    /** Done could not save the marked picture; the marks stay. */
    doneFailed: string;
    /** The tray picture's pen badge: reopen the marks. */
    editMarks: string;
  }>;
  viewer: Readonly<{
    stageCounter: (
      params: Readonly<{ current: number; total: number }>,
    ) => string;
    stageGallery: (params: Readonly<{ count: number }>) => string;
    stageItem: (
      params: Readonly<{ name: string; width: number; height: number }>,
    ) => string;
    openFile: string;
    viewFullScreen: string;
    hideControls: string;
    showControls: string;
    zoomIn: string;
    zoomOut: string;
    fit: string;
    actualSize: string;
    zoomPercent: (params: Readonly<{ percent: number }>) => string;
    download: string;
    share: string;
    loadFailed: (params: Readonly<{ name: string }>) => string;
    shownAt: (params: Readonly<{ scale: number }>) => string;
    background: string;
    backgroundCheckerboard: string;
    backgroundLight: string;
    backgroundDark: string;
    pdfLoading: string;
    megabytesOf: (
      params: Readonly<{ loaded: string; total: string }>,
    ) => string;
    pdfProtectedTitle: string;
    pdfProtectedBody: string;
    pdfDamagedTitle: string;
    pdfDamagedBody: string;
    pdfFailed: string;
    pdfPage: (params: Readonly<{ page: number; total: number }>) => string;
    pdfPageCount: (params: Readonly<{ count: number }>) => string;
    pdfFitWidth: string;
    pdfFitPage: string;
    pdfZoom: string;
    downloading: (
      params: Readonly<{ loaded: string; total: string }>,
    ) => string;
    loadStopped: (params: Readonly<{ name: string }>) => string;
    loadAgain: string;
    videoCantPlayTitle: string;
    audioCantPlayTitle: string;
    mediaCantPlayBody: string;
    openInDefaultApp: string;
    play: string;
    pause: string;
    playbackPosition: string;
    openAsText: string;
    remoteImages: (params: Readonly<{ count: number }>) => string;
    loadRemoteImages: string;
    imageOutsideWorkspace: string;
    before: string;
    after: string;
    beforeSide: string;
    afterSide: string;
    added: string;
    deleted: string;
  }>;
  kind: Readonly<
    Record<
      | 'code'
      | 'markdown'
      | 'image'
      | 'svg'
      | 'pdf'
      | 'video'
      | 'audio'
      | 'binary'
      | 'png'
      | 'jpeg'
      | 'gif'
      | 'webp'
      | 'bmp'
      | 'ico'
      | 'avif'
      | 'zip'
      | 'tar'
      | 'gzip'
      | 'rar'
      | 'sevenZip'
      | 'sqlite'
      | 'pe'
      | 'elf'
      | 'machO'
      | 'office'
      | 'font'
      | 'mp4'
      | 'mov'
      | 'webm'
      | 'mp3'
      | 'wav'
      | 'flac'
      | 'aac'
      | 'ogg',
      string
    >
  >;
}>;

export const fileViewerTranslationsEnglish = {
  en: {
    annotate: {
        annotate: "Annotate",
        tools: {
            title: "Tools",
            select: "Select",
            arrow: "Arrow",
            rectangle: "Rectangle",
            ellipse: "Ellipse",
            freehand: "Draw",
            highlighter: "Highlighter",
            text: "Text",
            step: "Numbered step",
            blur: "Blur",
            crop: "Crop",
            element: "Element",
        },
        colourAndStroke: "Colour and stroke",
        colour: "Colour",
        colours: {
            red: "Red",
            orange: "Orange",
            yellow: "Yellow",
            green: "Green",
            blue: "Blue",
            purple: "Purple",
            ink: "Ink",
        },
        stroke: { title: "Stroke", s: "Thin", m: "Medium", l: "Thick" },
        textSize: { title: "Text size", s: "Small", m: "Medium", l: "Large" },
        undo: "Undo",
        redo: "Redo",
        nothingToUndo: "Nothing to undo",
        nothingToRedo: "Nothing to redo",
        textMark: "Text mark",
        revert: "Revert to original",
        done: "Done",
        discardPrompt: "Discard marks?",
        keepEditing: "Keep editing",
        discard: "Discard",
        editableUntilSend: "marks stay editable until you send",
        doneFailed: "The marked picture couldn't be saved. Your marks are kept; try Done again.",
        editMarks: "Edit marks",
    },
    viewer: {
      stageCounter: ({ current, total }) => `${current} of ${total}`,
      stageGallery: ({ count }) => (count === 1 ? '1 item' : `${count} items`),
      stageItem: ({ name, width, height }) => `${name}, ${width} by ${height}`,
      openFile: 'Open file',
      viewFullScreen: 'View full screen',
      hideControls: 'Hide controls',
      showControls: 'Show controls',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fit: 'Fit',
      actualSize: 'Actual size',
      zoomPercent: ({ percent }) => `${percent}%`,
      download: 'Download',
      share: 'Share',
      loadFailed: ({ name }) => `Couldn't load ${name}`,
      shownAt: ({ scale }) => `Shown at ${scale}×`,
      background: 'Background',
      backgroundCheckerboard: 'Checkerboard',
      backgroundLight: 'Light',
      backgroundDark: 'Dark',
      pdfLoading: 'Loading PDF',
      megabytesOf: ({ loaded, total }) => `${loaded} of ${total} MB`,
      pdfProtectedTitle: 'This PDF is password-protected',
      pdfProtectedBody:
        "Happier can't open protected PDFs yet. Open it where you can enter the password.",
      pdfDamagedTitle: "This PDF can't be opened",
      pdfDamagedBody:
        "It isn't a valid PDF, or it is damaged. Open it in your default app to check.",
      pdfFailed: "Couldn't load this PDF",
      pdfPage: ({ page, total }) => `${page} / ${total}`,
      pdfPageCount: ({ count }) => (count === 1 ? '1 page' : `${count} pages`),
      pdfFitWidth: 'Fit width',
      pdfFitPage: 'Fit page',
      pdfZoom: 'Zoom',
      downloading: ({ loaded, total }) =>
        `Downloading ${loaded} of ${total} MB`,
      loadStopped: ({ name }) => `Stopped loading ${name}`,
      loadAgain: 'Load again',
      videoCantPlayTitle: "This video can't play here",
      audioCantPlayTitle: "This audio can't play here",
      mediaCantPlayBody:
        "This device doesn't support how it is encoded. Download it or open it in your default app.",
      openInDefaultApp: 'Open in default app',
      play: 'Play',
      pause: 'Pause',
      playbackPosition: 'Playback position',
      openAsText: 'Open as text',
      remoteImages: ({ count }) =>
        count === 1
          ? '1 remote image not loaded'
          : `${count} remote images not loaded`,
      loadRemoteImages: 'Load',
      imageOutsideWorkspace: 'Image outside this workspace',
      before: 'Before',
      after: 'After',
      beforeSide: 'HEAD',
      afterSide: 'working tree',
      added: 'Added',
      deleted: 'Deleted',
    },
    kind: {
      code: 'Text file',
      markdown: 'Markdown',
      image: 'Image',
      svg: 'SVG image',
      pdf: 'PDF document',
      video: 'Video',
      audio: 'Audio',
      binary: 'Binary file',
      png: 'PNG image',
      jpeg: 'JPEG image',
      gif: 'GIF image',
      webp: 'WebP image',
      bmp: 'BMP image',
      ico: 'Icon',
      avif: 'AVIF image',
      zip: 'ZIP archive',
      tar: 'Tar archive',
      gzip: 'Gzip archive',
      rar: 'RAR archive',
      sevenZip: '7-Zip archive',
      sqlite: 'SQLite database',
      pe: 'Windows executable',
      elf: 'Linux executable',
      machO: 'Mach-O executable',
      office: 'Office document',
      font: 'Font',
      mp4: 'MPEG-4 video',
      mov: 'QuickTime video',
      webm: 'WebM video',
      mp3: 'MP3 audio',
      wav: 'WAV audio',
      flac: 'FLAC audio',
      aac: 'AAC audio',
      ogg: 'Ogg audio',
    },
  },
} satisfies Pick<Record<string, FileViewerTranslations>, 'en'>;
