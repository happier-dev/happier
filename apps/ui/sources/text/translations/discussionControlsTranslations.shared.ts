type Count = Readonly<{ count: number }>;
type More = Readonly<{ first: string; count: number }>;

/** The Discussion menu's check-in row and the composer's Send to chip (C3 DISC-17, DISC-18). */
export const discussionControlsCopy = {
  en: {
    incomingMessage: 'Incoming message',
    dontPause: 'Don’t pause this Discussion',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Follows your setting: pauses after 1 turn'
        : `Follows your setting: pauses after ${count} turns`,
    inheritsNever: 'Follows your setting: never pauses',
    neverHere: 'Agents keep going here until you stop them',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Pauses here after 1 turn'
        : `Pauses here after ${count} turns`,
    unavailable: 'This setting can’t be read right now',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  ca: {
    incomingMessage: 'Missatge entrant',
    dontPause: 'No posis en pausa aquesta discussió',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Segueix la teva configuració: s’atura després d’1 torn'
        : `Segueix la teva configuració: s’atura després de ${count} torns`,
    inheritsNever: 'Segueix la teva configuració: no s’atura mai',
    neverHere: 'Aquí els agents continuen fins que els aturis',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Aquí s’atura després d’1 torn'
        : `Aquí s’atura després de ${count} torns`,
    unavailable: 'Ara no es pot llegir aquesta configuració',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  de: {
    incomingMessage: 'Eingehende Nachricht',
    dontPause: 'Diese Diskussion nicht pausieren',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Folgt deiner Einstellung: pausiert nach 1 Zug'
        : `Folgt deiner Einstellung: pausiert nach ${count} Zügen`,
    inheritsNever: 'Folgt deiner Einstellung: pausiert nie',
    neverHere: 'Agenten machen hier weiter, bis du sie stoppst',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Pausiert hier nach 1 Zug'
        : `Pausiert hier nach ${count} Zügen`,
    unavailable: 'Diese Einstellung kann gerade nicht gelesen werden',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  es: {
    incomingMessage: 'Mensaje entrante',
    dontPause: 'No pausar esta discusión',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Sigue tu ajuste: se pausa tras 1 turno'
        : `Sigue tu ajuste: se pausa tras ${count} turnos`,
    inheritsNever: 'Sigue tu ajuste: nunca se pausa',
    neverHere: 'Aquí los agentes siguen hasta que los detengas',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Aquí se pausa tras 1 turno'
        : `Aquí se pausa tras ${count} turnos`,
    unavailable: 'Ahora no se puede leer este ajuste',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  fr: {
    incomingMessage: 'Message entrant',
    dontPause: 'Ne pas mettre cette discussion en pause',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Suit votre réglage : pause après 1 tour'
        : `Suit votre réglage : pause après ${count} tours`,
    inheritsNever: 'Suit votre réglage : jamais de pause',
    neverHere: 'Ici, les agents continuent jusqu’à ce que vous les arrêtiez',
    turnsHere: ({ count }: Count) =>
      count === 1 ? 'Pause ici après 1 tour' : `Pause ici après ${count} tours`,
    unavailable: 'Ce réglage ne peut pas être lu pour le moment',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  it: {
    incomingMessage: 'Messaggio in arrivo',
    dontPause: 'Non mettere in pausa questa discussione',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Segue la tua impostazione: pausa dopo 1 turno'
        : `Segue la tua impostazione: pausa dopo ${count} turni`,
    inheritsNever: 'Segue la tua impostazione: mai in pausa',
    neverHere: 'Qui gli agenti continuano finché non li fermi',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Qui va in pausa dopo 1 turno'
        : `Qui va in pausa dopo ${count} turni`,
    unavailable: 'Al momento questa impostazione non è leggibile',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  ja: {
    incomingMessage: '受信メッセージ',
    dontPause: 'このディスカッションを一時停止しない',
    inheritsTurns: ({ count }: Count) =>
      `設定に従う：${count} ターン後に一時停止`,
    inheritsNever: '設定に従う：一時停止しない',
    neverHere: 'ここではあなたが止めるまでエージェントが続けます',
    turnsHere: ({ count }: Count) => `ここでは ${count} ターン後に一時停止`,
    unavailable: '現在この設定を読み込めません',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  pl: {
    incomingMessage: 'Wiadomość przychodząca',
    dontPause: 'Nie wstrzymuj tej dyskusji',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Według Twojego ustawienia: pauza po 1 turze'
        : `Według Twojego ustawienia: pauza po ${count} turach`,
    inheritsNever: 'Według Twojego ustawienia: bez pauzy',
    neverHere: 'Tutaj agenci działają, dopóki ich nie zatrzymasz',
    turnsHere: ({ count }: Count) =>
      count === 1 ? 'Tutaj pauza po 1 turze' : `Tutaj pauza po ${count} turach`,
    unavailable: 'Nie można teraz odczytać tego ustawienia',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  pt: {
    incomingMessage: 'Mensagem recebida',
    dontPause: 'Não pausar esta discussão',
    inheritsTurns: ({ count }: Count) =>
      count === 1
        ? 'Segue sua configuração: pausa após 1 turno'
        : `Segue sua configuração: pausa após ${count} turnos`,
    inheritsNever: 'Segue sua configuração: nunca pausa',
    neverHere: 'Aqui os agentes continuam até você pará-los',
    turnsHere: ({ count }: Count) =>
      count === 1
        ? 'Aqui pausa após 1 turno'
        : `Aqui pausa após ${count} turnos`,
    unavailable: 'Não é possível ler esta configuração agora',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  ru: {
    incomingMessage: 'Входящее сообщение',
    dontPause: 'Не ставить это обсуждение на паузу',
    inheritsTurns: ({ count }: Count) =>
      `По вашей настройке: пауза после ходов: ${count}`,
    inheritsNever: 'По вашей настройке: без пауз',
    neverHere: 'Здесь агенты продолжают, пока вы их не остановите',
    turnsHere: ({ count }: Count) => `Здесь пауза после ходов: ${count}`,
    unavailable: 'Сейчас не удаётся прочитать эту настройку',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  'zh-Hans': {
    incomingMessage: '收到的消息',
    dontPause: '不要暂停此讨论',
    inheritsTurns: ({ count }: Count) => `沿用你的设置：${count} 轮后暂停`,
    inheritsNever: '沿用你的设置：从不暂停',
    neverHere: '在这里，智能体会一直继续，直到你停止它们',
    turnsHere: ({ count }: Count) => `在这里 ${count} 轮后暂停`,
    unavailable: '暂时无法读取此设置',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
  'zh-Hant': {
    incomingMessage: '收到的訊息',
    dontPause: '不要暫停此討論',
    inheritsTurns: ({ count }: Count) => `沿用你的設定：${count} 輪後暫停`,
    inheritsNever: '沿用你的設定：永不暫停',
    neverHere: '在這裡，代理會一直繼續，直到你停止它們',
    turnsHere: ({ count }: Count) => `在這裡 ${count} 輪後暫停`,
    unavailable: '暫時無法讀取此設定',
    recipientsMore: ({ first, count }: More) => `${first} +${count}`,
  },
};
