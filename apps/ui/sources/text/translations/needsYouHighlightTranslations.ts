import type { SupportedLanguage } from '../_all';

/** Appearance → Sessions: "Highlight sessions that need you" (owner ruling 2026-11-01). */
type NeedsYouHighlightCopy = Readonly<{ title: string; description: string; dot: string; accent: string; glint: string; shimmer: string; pulse: string }>;

export const needsYouHighlightTranslations = {
  en: { title: 'Highlight sessions that need you', description: 'How a session that needs you stands out in the list on this device. Motion stops once you open it.', dot: 'Dot', accent: 'Accent', glint: 'Glint', shimmer: 'Shimmer', pulse: 'Pulse' },
  fr: { title: 'Signaler les sessions qui ont besoin de vous', description: 'Comment une session qui a besoin de vous ressort dans la liste sur cet appareil. Le mouvement s’arrête dès que vous l’ouvrez.', dot: 'Point', accent: 'Trait', glint: 'Reflet', shimmer: 'Miroitement', pulse: 'Pulsation' },
  de: { title: 'Sitzungen hervorheben, die dich brauchen', description: 'Wie eine Sitzung, die dich braucht, in der Liste auf diesem Gerät auffällt. Die Bewegung endet, sobald du sie öffnest.', dot: 'Punkt', accent: 'Akzent', glint: 'Glanz', shimmer: 'Schimmer', pulse: 'Puls' },
  es: { title: 'Destacar las sesiones que te necesitan', description: 'Cómo destaca en la lista de este dispositivo una sesión que te necesita. El movimiento se detiene al abrirla.', dot: 'Punto', accent: 'Acento', glint: 'Destello', shimmer: 'Brillo', pulse: 'Pulso' },
  it: { title: 'Evidenzia le sessioni che ti cercano', description: 'Come risalta nell’elenco su questo dispositivo una sessione che ha bisogno di te. Il movimento si ferma quando la apri.', dot: 'Punto', accent: 'Accento', glint: 'Riflesso', shimmer: 'Luccichio', pulse: 'Pulsazione' },
  pt: { title: 'Destacar sessões que precisam de você', description: 'Como uma sessão que precisa de você se destaca na lista neste dispositivo. O movimento para quando você a abre.', dot: 'Ponto', accent: 'Destaque', glint: 'Reflexo', shimmer: 'Brilho', pulse: 'Pulso' },
  ca: { title: 'Destaca les sessions que et necessiten', description: 'Com destaca a la llista d’aquest dispositiu una sessió que et necessita. El moviment s’atura quan l’obres.', dot: 'Punt', accent: 'Accent', glint: 'Reflex', shimmer: 'Lluentor', pulse: 'Pols' },
  pl: { title: 'Wyróżniaj sesje, które cię potrzebują', description: 'Jak sesja, która cię potrzebuje, wyróżnia się na liście na tym urządzeniu. Ruch ustaje po jej otwarciu.', dot: 'Kropka', accent: 'Akcent', glint: 'Błysk', shimmer: 'Migotanie', pulse: 'Puls' },
  ru: { title: 'Выделять сессии, которым нужны вы', description: 'Как сессия, которой нужны вы, выделяется в списке на этом устройстве. Движение прекращается, когда вы её открываете.', dot: 'Точка', accent: 'Акцент', glint: 'Блик', shimmer: 'Мерцание', pulse: 'Пульс' },
  ja: { title: '対応が必要なセッションを目立たせる', description: 'このデバイスのリストで、対応が必要なセッションをどう目立たせるか。開くと動きは止まります。', dot: 'ドット', accent: 'アクセント', glint: 'きらめき', shimmer: 'シマー', pulse: 'パルス' },
  'zh-Hans': { title: '突出显示需要你的会话', description: '在此设备的列表中，需要你的会话如何显示。打开后动画停止。', dot: '圆点', accent: '强调条', glint: '闪光', shimmer: '微光', pulse: '脉动' },
  'zh-Hant': { title: '突顯需要你的工作階段', description: '在此裝置的清單中，需要你的工作階段如何顯示。開啟後動畫停止。', dot: '圓點', accent: '強調條', glint: '閃光', shimmer: '微光', pulse: '脈動' },
} as const satisfies Record<SupportedLanguage, NeedsYouHighlightCopy>;

/** Appearance → Sessions: the restored 0.2 working indicator and playful working words (owner amendment 2026-11-01). */
type WorkingIndicatorCopy = Readonly<{ title: string; description: string; spinner: string; pulse: string; animatedTextTitle: string; animatedTextDescription: string }>;

export const workingIndicatorTranslations = {
  en: { title: 'Working indicator', description: 'How a working session shows in the list.', spinner: 'Spinner', pulse: 'Pulsing dot', animatedTextTitle: 'Playful working words', animatedTextDescription: 'With status words on, a working session shows a playful word instead of “Working”.' },
  fr: { title: 'Indicateur d’activité', description: 'Comment une session au travail apparaît dans la liste.', spinner: 'Rotation', pulse: 'Point pulsé', animatedTextTitle: 'Mots d’activité ludiques', animatedTextDescription: 'Avec les mots d’état, une session au travail affiche un mot ludique au lieu de « Au travail ».' },
  de: { title: 'Arbeitsanzeige', description: 'Wie eine arbeitende Sitzung in der Liste erscheint.', spinner: 'Spinner', pulse: 'Pulsierender Punkt', animatedTextTitle: 'Verspielte Arbeitswörter', animatedTextDescription: 'Mit Statuswörtern zeigt eine arbeitende Sitzung ein verspieltes Wort statt „Arbeitet“.' },
  es: { title: 'Indicador de trabajo', description: 'Cómo aparece en la lista una sesión que está trabajando.', spinner: 'Giro', pulse: 'Punto pulsante', animatedTextTitle: 'Palabras de trabajo divertidas', animatedTextDescription: 'Con las palabras de estado, una sesión que trabaja muestra una palabra divertida en lugar de «Trabajando».' },
  it: { title: 'Indicatore di lavoro', description: 'Come appare nell’elenco una sessione al lavoro.', spinner: 'Rotella', pulse: 'Punto pulsante', animatedTextTitle: 'Parole di lavoro giocose', animatedTextDescription: 'Con le parole di stato, una sessione al lavoro mostra una parola giocosa invece di «Al lavoro».' },
  pt: { title: 'Indicador de trabalho', description: 'Como uma sessão em trabalho aparece na lista.', spinner: 'Giro', pulse: 'Ponto pulsante', animatedTextTitle: 'Palavras de trabalho divertidas', animatedTextDescription: 'Com as palavras de estado, uma sessão em trabalho mostra uma palavra divertida em vez de “Trabalhando”.' },
  ca: { title: 'Indicador de feina', description: 'Com apareix a la llista una sessió que treballa.', spinner: 'Gir', pulse: 'Punt polsant', animatedTextTitle: 'Paraules de feina divertides', animatedTextDescription: 'Amb les paraules d’estat, una sessió que treballa mostra una paraula divertida en lloc de «Treballant».' },
  pl: { title: 'Wskaźnik pracy', description: 'Jak pracująca sesja wygląda na liście.', spinner: 'Kółko', pulse: 'Pulsująca kropka', animatedTextTitle: 'Zabawne słowa pracy', animatedTextDescription: 'Przy słowach stanu pracująca sesja pokazuje zabawne słowo zamiast „Pracuje”.' },
  ru: { title: 'Индикатор работы', description: 'Как работающая сессия выглядит в списке.', spinner: 'Спиннер', pulse: 'Пульсирующая точка', animatedTextTitle: 'Игривые слова работы', animatedTextDescription: 'Со словами статуса работающая сессия показывает игривое слово вместо «Работает».' },
  ja: { title: '作業中インジケーター', description: '作業中のセッションをリストでどう表示するか。', spinner: 'スピナー', pulse: '点滅ドット', animatedTextTitle: '遊び心のある作業ワード', animatedTextDescription: 'ステータスワードがオンのとき、作業中のセッションに「作業中」の代わりに遊び心のある言葉を表示します。' },
  'zh-Hans': { title: '工作指示器', description: '工作中的会话在列表中的显示方式。', spinner: '旋转', pulse: '脉动圆点', animatedTextTitle: '趣味工作词', animatedTextDescription: '开启状态词时，工作中的会话显示趣味词语，而不是“工作中”。' },
  'zh-Hant': { title: '工作指示器', description: '工作中的工作階段在清單中的顯示方式。', spinner: '旋轉', pulse: '脈動圓點', animatedTextTitle: '趣味工作詞', animatedTextDescription: '開啟狀態詞時，工作中的工作階段顯示趣味詞語，而非「工作中」。' },
} as const satisfies Record<SupportedLanguage, WorkingIndicatorCopy>;
